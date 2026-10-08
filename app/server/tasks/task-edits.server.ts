/**
 * A task's own fields, as a person or the operator changes them (ruling 654):
 * creating a task, and editing its goal, title and metadata, and the files
 * attached to it.
 */

import { lstatSync, unlinkSync } from "node:fs";
import path from "node:path";
import { storedFileName, storedNameAmong } from "~/server/files/file-store-root.server";
import {
  checkAttachmentBatch,
  checkAttachmentUpload,
  listTaskAttachmentNames,
  resolveTaskAttachment,
  withAttachmentClaims,
  writeTaskAttachment,
  type WrittenAttachment,
} from "~/server/files/task-attachments.server";
import { FILING_BATCH } from "~/shared/attachment-kinds";
import { resolveDependencies } from "~/server/projections/dependencies.server";
import { findUserById } from "~/server/auth/user-store.server";
import { endSentence } from "~/shared/text/sentence";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidDueDate,
  normalizeTaskLabels,
  PRIORITY_VALUES,
  type TaskFileEvent,
  type TaskFrontmatter,
  type TaskPriority,
} from "~/schemas/task-file.schema";
import { releaseTask, validateDependencyRefs } from "./dependencies.server";
import { holdEntriesSentence, joinDependencyEntries } from "~/shared/dependencies";
import { type AuditEventInput, recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  loadProjectContext,
  notifyOwnerSeatChange,
  reprojectTask,
  summaryOrThrow,
  type TaskActor,
  type TaskMutationContext,
  taskRef,
} from "./task-mutation.server";
import { createTaskFile, readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { allocateTaskKey } from "~/server/files/project-writer.server";
import { reprojectProject } from "~/server/projections/rebuilder.server";
import { readEpicFile } from "~/server/files/epic-writer.server";
import { noteTaskMadeInEpic, requireEpicForNewTask } from "./epic-actions.server";
import {
  type ClosedDecision,
  followClosedDecision,
  markTaskPacketApprovalRead,
} from "~/server/projections/notifications.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { logger } from "~/server/logging/logger.server";
import { userDisplayName } from "./user-display-name.server";
import { toError } from "~/shared/errors";
import {
  attachmentKb,
  autoInvokeOperator,
  humanActorRef,
  OPERATOR_TASK_ACTOR,
  ownerAssignEvent,
  requireAction,
  requireOwnable,
  type TaskActionContext,
} from "./task-action-core.server";

export const DEFAULT_GOAL = "Goal to be refined at the triage quality gate.";

/** Validate an optional create-time due date to the same rule the edit action
 *  enforces: blank/omitted → null, a real `YYYY-MM-DD` → itself, anything else
 *  is a validation error (never a silently-dropped bad date). */
function normalizeCreateDueDate(dueDate: string | null | undefined): string | null {
  const raw = dueDate?.trim() ?? "";
  if (raw === "") return null;
  if (isValidDueDate(raw)) return raw;
  throw AppError.validation(
    `Due date must be a calendar date (YYYY-MM-DD); got "${dueDate}".`,
  );
}

export interface CreateTaskInput {
  projectSlug: string;
  title: string;
  goal?: string;
  /** Entry stage only (R19-14): when given it must equal the first stage;
   *  omitted defaults to it. Any other stage is refused. */
  stageId?: string;
  /** Pass-25 task metadata (all optional at creation). */
  priority?: TaskPriority;
  labels?: string[];
  dueDate?: string | null;
  /** Ruling 503: the epic the new task joins (`epic-3`), checked BEFORE a
   *  key is allocated like the wait below. Absent or null: in no epic. */
  epic?: string | null;
  /**
   * Ruling 477(b) (F40-28): an automation creating the task on a person's
   * authority signs the creation's events itself, so the Activity stream's
   * Humans filter does not credit that person with a creation they never
   * made. The seat, the `task.created` audit row and its actor are unchanged.
   * Ruling 503's goal-to-epic conversion is the one caller.
   */
  signedBy?: { systemId: string; assignText: string };
  /** Ruling 131: what the new task waits on, validated BEFORE a key is
   *  allocated so a refusal burns no key; the task is born held
   *  (`waiting: "none"`, readiness floored at `blocked` by derivation). */
  blockedBy?: readonly string[];
  /** Ruling 140(a): the member to seat as owner at creation, checked by the
   *  same rule as a hand-off (`requireOwnable`) and written in the SAME
   *  task.md write, before the operator's `create` trigger. Absent: the
   *  creator is seated (ruling 127). */
  ownerUserId?: string | null;
  /** Ruling 533: the files the person filed the task with (an inventory, a
   *  screenshot, a spreadsheet). Checked before the key is allocated and
   *  saved before the operator's `create` trigger, so triage reads them. */
  attachments?: readonly { name: string; data: Uint8Array }[];
  /** Ruling 255: the instant this creation happened. Every field and every
   *  timeline event it writes carries it, so the file's order is the
   *  arrangement and not a race between clock reads. Test seam only — the
   *  routes never pass it, and it defaults to now. */
  now?: string;
}

/**
 * Board "New task" flow: allocates the next `<PREFIX>-<n>` key atomically
 * from the per-project counter in project.md, writes the task file with the
 * mock create defaults, reprojects, audits.
 * RBAC: any project member except viewers (board spec §5.1).
 */
export async function createTask(
  db: DatabaseSync,
  input: CreateTaskInput,
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<{ key: string; task: TaskSummary; stageName: string }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "create-task", "create tasks");

  const title = input.title.trim();
  if (title.length < 3) {
    throw AppError.validation("A title of at least 3 characters is required.");
  }
  if (input.priority !== undefined && !PRIORITY_VALUES.includes(input.priority)) {
    throw AppError.validation(`Unknown priority "${input.priority}".`);
  }
  // R19-14: every task goes through the triage quality gate, so creation lands
  // at the entry stage only — downstream stages presuppose work that has not
  // happened yet. An omitted stageId still defaults to entry.
  const stage = project.stages[0];
  if (!stage) {
    throw AppError.validation("This project has no stages to create a task in.");
  }
  if (input.stageId !== undefined && input.stageId !== stage.id) {
    throw AppError.validation(
      `New tasks start at ${stage.name}, the triage gate where a goal is refined. Move the task through the workflow after it is created.`,
    );
  }
  const stageId = stage.id;
  // Ruling 127: only a HUMAN can be seated as owner — the seat is an account
  // to bill and a person to hold review authority. A controller-driven human
  // IS a human (the controller acts as them, with their user id); the operator
  // toolkit's placeholder actor is not, and neither is any other in-process
  // system actor.
  const creator: TaskActor | null =
    ctx.operatorAuthorized || actor.userId === OPERATOR_TASK_ACTOR.userId
      ? null
      : actor;
  // Degenerate single-stage project: the entry stage IS the done stage, and
  // nothing may be created straight into done.
  if (stageId === project.stages[project.stages.length - 1]?.id) {
    throw AppError.validation("New tasks cannot be created in the done stage.");
  }

  // Pass 34 review: an invalid date must not burn a task key. Normalized here,
  // beside the other pre-allocation checks, and used verbatim below.
  const dueDate = normalizeCreateDueDate(input.dueDate);

  // Ruling 140(a): a named owner is checked BEFORE the key is allocated, by
  // the hand-off rule. The creator is the implicit first owner, so naming
  // themselves records the creator seat; an operator-authorized creation has
  // no person to seat and keeps its null seat.
  const namedOwnerId = input.ownerUserId?.trim() || null;
  if (namedOwnerId && !creator) {
    throw AppError.validation(
      "A named owner is seated by a person; an operator-created task starts unowned.",
    );
  }
  const seat: "creator" | "named" | "none" =
    namedOwnerId && creator && namedOwnerId !== creator.userId
      ? "named"
      : creator
        ? "creator"
        : "none";
  if (seat === "named" && namedOwnerId) requireOwnable(project, namedOwnerId);
  const namedOwner = seat === "named" && namedOwnerId ? findUserById(db, namedOwnerId) : null;
  if (seat === "named" && !namedOwner) {
    throw AppError.notFound("No Viberr user with that id.");
  }

  // Ruling 131: validate the wait BEFORE the key is allocated — a refused
  // reference must not burn a counter value.
  const blockedBy = input.blockedBy?.length
    ? validateDependencyRefs(db, { projectSlug: input.projectSlug, self: null, entries: input.blockedBy })
    : [];
  // Ruling 503: and the epic, for the same reason.
  const epic = input.epic?.trim() ? requireEpicForNewTask(ctx, input.projectSlug, input.epic) : null;
  // Ruling 533: and the files it is filed with, by the upload's own tier.
  const filed = input.attachments ?? [];
  if (filed.length > 0) {
    requireAction(db, project, actor, "attach-file", "attach a file to a task");
  }
  // Checked BEFORE the key is allocated, so one refused file refuses the
  // whole filing and burns no key.
  const filedNames = checkAttachmentBatch(filed, FILING_BATCH);

  const projectRef = {
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  };
  const key = await allocateTaskKey(projectRef);
  const now = input.now ?? new Date().toISOString();

  const frontmatter: TaskFrontmatter = {
    key,
    title,
    // Ruling 388: nothing delivered yet.
    deliveredAt: null,
    stage: stageId,
    // No transition has happened yet — the previous stage is a fact only a
    // real move writes.
    previousStageId: null,
    heldAtStage: null,
    readiness: "input_required",
    // Ruling 131(a): a task born waiting on other work owes nobody anything.
    waiting: blockedBy.length > 0 ? "none" : "human",
    // Ruling 127: creation SEATS the creator as owner. Every agent run on a
    // task bills the OWNER's own Claude/Codex accounts, so a task with no owner
    // cannot run agents at all — and the pre-127 default (`null`) meant every
    // brand-new task was born unable to do the one thing it exists for, with
    // an "Assign me" ceremony standing between a person and their own work. An
    // OPERATOR-created task keeps a null seat: the operator is not a person and
    // has no account to bill; a human has to take that one.
    // Ruling 140(a): a named owner is seated in this same write, before the
    // operator's `create` trigger reads the file, so the first triage run
    // bills the named owner and is refused honestly when they have no
    // credential, instead of running once on the creator's account.
    ownerUserId: seat === "named" ? namedOwnerId : (creator?.userId ?? null),
    engagements: [],
    recommendations: [],
    schedules: [],
    queuedQuestions: [],
    // R19-14: creation is gated to the entry stage above, and a task in triage
    // has no operator until it advances (contracts §1.1) — always null at birth.
    operator: null,
    priority: input.priority ?? "normal",
    labels: input.labels ? normalizeTaskLabels(input.labels) : [],
    dueDate,
    // F26-16: `urgent` is the SINGLE derived mirror of `priority === "urgent"` —
    // the board highlight and "Blocked or waiting" filter read `urgent`, and it must
    // never disagree with the graded scale. Derived purely here (no separate input)
    // so the two cannot desync; the edit path (`setTaskMetadata`) does the same.
    urgent: input.priority === "urgent",
    blockedBy,
    archived: false,
    validation: "none",
    workRevision: null,
    verdicts: [],
    baseRefreshes: [],
    branch: null,
    pr: null,
    github: null,
    epic,
    createdAt: now,
    updatedAt: now,
    boardRank: null,
  };

  const createInput: Parameters<typeof createTaskFile>[1] = {
    frontmatter,
    goal: input.goal?.trim() || DEFAULT_GOAL,
  };
  // The same `assign` event a take through `setOwner` writes, so the timeline
  // reads the same however the seat was filled (ruling 127).
  // Ruling 255: ONE creation is one instant. Every event this write puts on the
  // timeline carries the frontmatter's own `now`, so the file's order is the
  // deliberate arrangement and not a race between two `new Date()` calls.
  const signer: FileActorRef | null = input.signedBy
    ? { kind: "system", systemId: input.signedBy.systemId }
    : null;
  if (creator && signer && input.signedBy) {
    createInput.timeline = [
      { ...ownerAssignEvent(db, creator, input.signedBy.assignText, now), actor: signer },
    ];
  } else if (creator && seat === "named" && namedOwner) {
    createInput.timeline = [
      ownerAssignEvent(
        db,
        creator,
        `Seated ${namedOwner.name} as owner at creation. Agent runs on this task use the owner's own Claude and Codex accounts, and the owner is its human reviewer and acceptance authority.`,
        now,
      ),
    ];
  } else if (creator) {
    createInput.timeline = [
      ownerAssignEvent(
        db,
        creator,
        "Took task ownership by creating the task. Agent runs on this task use the owner's own Claude and Codex accounts, and the owner is its human reviewer and acceptance authority.",
        now,
      ),
    ];
  }
  // Ruling 533: the files the task was filed with are written BEFORE the task
  // file, so the operator's `create` trigger below reads a task whose input is
  // already on it, and the note that names them claims them for the person:
  // the attachments panel says who added each one, and no agent run is ever
  // credited with them.
  const written = filed.map((file, i) =>
    writeTaskAttachment(input.projectSlug, key, filedNames[i]!, file.data, ctx.dataRoot),
  );
  if (written.length > 0) {
    const listed = joinDependencyEntries(written.map((w) => `\`${w.name}\` (${attachmentKb(w.bytes)})`));
    const filedNote: TaskFileEvent = {
      occurredAt: now,
      type: "note",
      actor: signer ?? (creator ? humanActorRef(db, creator) : { kind: "operator" }),
      title: "Attachment added",
      text:
        `Filed with ${listed}. ` +
        `Agents on this task read ${written.length === 1 ? "it" : "them"} from the task's attachments.`,
      toAgent: false,
      evidence: null,
      attachments: written.map((w) => w.name),
    };
    createInput.timeline = [filedNote, ...(createInput.timeline ?? [])];
  }
  const waitEntries = resolveDependencies(db, input.projectSlug, blockedBy);
  const waitAllDone = waitEntries.length > 0 && waitEntries.every((e) => e.state === "done");
  if (blockedBy.length > 0) {
    const waitNote: TaskFileEvent = {
      occurredAt: now,
      type: "note",
      actor: signer ?? (creator ? humanActorRef(db, creator) : { kind: "operator" }),
      title: "Waits on other work",
      // Ruling 356(b): the note names a done entry as done, like every other
      // hold sentence — 4 of 56 creation notes on the instance had named a task
      // that was already Done at creation (BNB-26: "waiting on BNB-5, BNB-22"
      // with BNB-22 closed 95 s earlier).
      // F39-65: and a list that is ALL done holds nothing. Chain links were
      // created only once their waits were satisfied, so every one opened with
      // "Held until every entry is done" over eight entries that were (AX-35),
      // released in the same second.
      text: waitAllDone
        ? `Created after the work it waits on was done (${joinDependencyEntries(waitEntries.map((e) => e.label))}), so nothing holds it; Viberr releases the list at once.`
        : `Created waiting on ${holdEntriesSentence(waitEntries)}. Held until every entry is done; Viberr releases it then.`,
      toAgent: false,
      evidence: null,
    };
    createInput.timeline = [waitNote, ...(createInput.timeline ?? [])];
  }
  if (epic) {
    // Ruling 503: the same note `setTasksEpic` writes when a task joins later,
    // so the timeline says where the task sits however it got there.
    const epicTitle = readEpicFile({ projectSlug: input.projectSlug, epicId: epic, dataRoot: ctx.dataRoot })
      ?.parsed.frontmatter.title;
    const epicNote: TaskFileEvent = {
      occurredAt: now,
      type: "note",
      actor: signer ?? (creator ? humanActorRef(db, creator) : { kind: "operator" }),
      title: "Epic",
      text: `Added to **${epic}**${epicTitle ? ` (${epicTitle})` : ""}.`,
      toAgent: false,
      evidence: null,
    };
    createInput.timeline = [epicNote, ...(createInput.timeline ?? [])];
  }
  await createTaskFile(taskRef(ctx, input.projectSlug, key), createInput);

  // project.md changed too (counter bump) — reproject both.
  reprojectProject(db, ctx, input.projectSlug);
  reprojectTask(db, ctx, input.projectSlug, key);

  // Ruling 140(b): a creation that seats someone ELSE tells them, in the same
  // shape a hand-off uses; the audit row then says whether they were told.
  const createdDetails: NonNullable<AuditEventInput["details"]> = {
    title,
    stage: stageId,
    ownerUserId: frontmatter.ownerUserId,
    seat,
  };
  if (epic) createdDetails.epic = epic;
  if (written.length > 0) createdDetails.attachments = written.map((w) => w.name);
  if (seat === "named" && namedOwnerId && creator) {
    const seatNotified = notifyOwnerSeatChange(db, {
      projectSlug: input.projectSlug,
      recipientUserId: namedOwnerId,
      actor: creator,
      actorName: userDisplayName(db, creator.userId),
      change: { kind: "seated_at_creation", taskKey: key },
      // The creation's `assign` event carries the file's own `now`.
      eventAt: now,
    });
    if (seatNotified) createdDetails.notified = seatNotified;
  }
  recordAudit(db, {
    action: "task.created",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: key,
    projectSlug: input.projectSlug,
    taskKey: key,
    details: createdDetails,
  });
  // Ruling 533: each filed file is on the audit log as an attachment, the row a
  // later upload writes, so a search for what a person attached finds both.
  for (const attachment of written) {
    recordAudit(db, {
      action: "task.attachment.added",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "task",
      subjectId: key,
      projectSlug: input.projectSlug,
      taskKey: key,
      details: { name: attachment.name, bytes: attachment.bytes, replaced: false },
    });
  }
  // L02-1: the note above promises "Viberr releases the list at once". Only the
  // goal runner kept that promise, for the links it minted (ruling 358), and
  // ruling 503 removed it; every other creation waited for the minute tick,
  // which released the task as an ordinary hold with the false claims F39-65
  // removed. Nothing has awaited since the task was projected, so the tick
  // cannot take the file first. The release's own turn hands the task to its
  // operator, in place of `create`.
  const releasedAtBirth =
    waitAllDone &&
    (await releaseTask(db, ctx, input.projectSlug, key, { atBirth: true }).catch((error) => {
      logger.warn("a task created on finished work could not be released at creation", {
        taskKey: key,
        err: toError(error),
      });
      return false;
    }));
  // Ruling 503(b): the epic's history and its lead hear of a task made in it.
  // The conversion's own tasks are named by its line on the epic instead.
  if (epic && !signer) {
    await noteTaskMadeInEpic(db, { projectSlug: input.projectSlug, epicId: epic, taskKey: key }, actor, ctx);
  }

  // A dedicated operator coordinates every active task (ADR-002): auto-invoke
  // it to pick up the new task. Fire-and-forget — it never blocks or fails the
  // create, and it is a no-op when the project has no operator deployed.
  if (!releasedAtBirth) void autoInvokeOperator(db, ctx, input.projectSlug, key, "create");

  return {
    key,
    task: summaryOrThrow(db, input.projectSlug, key),
    stageName: stage.name,
  };
}

/** Edit the canonical goal, audit it, and re-engage the operator. */
export async function updateTaskGoal(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; goal: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary; changed: boolean }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "update-goal", "edit the task goal");
  const goal = input.goal.trim();
  if (goal.length < 3) {
    throw AppError.validation("A goal of at least 3 characters is required.");
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (existing.parsed.goal.trim() === goal) {
    // F35-6 (pass 35): an unchanged save is not an edit. While a decided
    // `edit_goal` packet waits for the edited goal, saving the original text
    // used to answer 200 + "Goal updated" and leave the packet open (KNC-4);
    // say so instead. Without a packet the caller is told nothing changed.
    if (existing.parsed.packet?.awaiting === "goal_edit") {
      throw AppError.validation(
        "The goal reads exactly as before, so the requested edit has not landed. Open the requested goal from the decision card, or write the edit.",
      );
    }
    return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), changed: false };
  }

  /** Ruling 547: the awaiting packet this edit fulfils, and its record. */
  let clearedPacket: ClosedDecision | null = null;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.goal = goal;
    // V18: an edited goal re-litigates a recorded deliberate hold — the hold
    // was the operator honoring the OLD goal.
    parsed.frontmatter.heldAtStage = null;
    // A confirmed `edit_goal` packet decision is fulfilled by THIS edit —
    // clear the packet immediately (no operator round-trip). A blocked packet
    // lifted its own readiness gate with it.
    if (parsed.packet?.awaiting === "goal_edit") {
      const wasBlocked = parsed.packet.type === "blocked";
      const closedAt = new Date().toISOString();
      clearedPacket = { packetId: parsed.packet.id, closedAt };
      parsed.packet = null;
      if (wasBlocked && parsed.frontmatter.readiness === "blocked") {
        parsed.frontmatter.readiness = "ready";
      }
      parsed.timeline.unshift({
        occurredAt: closedAt,
        type: "transition",
        actor: humanActorRef(db, actor),
        title: null,
        text: "**Packet resolved:** the requested goal edit landed.",
        toAgent: false,
        evidence: null,
      });
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      // Neutral lifecycle note — a human editing the goal is not a policy
      // violation (P13-LV-03).
      type: "note",
      actor: humanActorRef(db, actor),
      title: "Goal updated",
      text: "The task goal / acceptance criteria were edited. Downstream agents re-anchor on the new goal.",
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
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {},
  });
  // Re-engage the operator so it reads the amended goal on its next turn —
  // the dedicated trigger tells it to withdraw a now-moot scope packet
  // (resolve_decision_packet) instead of treating this as a generic poke.
  void autoInvokeOperator(db, ctx, input.projectSlug, input.taskKey, "goal-updated");

  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), changed: true };
}

/** A partial metadata edit — the axes a caller chose to touch (an omitted axis
 *  is left unchanged). Shared by the validated `patch` and the audit `details`
 *  so both carry the same named owner contract. */
type TaskMetadataPatch = {
  priority?: TaskPriority;
  labels?: string[];
  dueDate?: string | null;
};

/**
 * F39-6 (pass 39): a PERSON attaches a file to a task.
 *
 * The attachments directory had three readers and no human writer: the browser
 * MCP's `--output-dir` and the agent evidence drop could put files there,
 * nobody could. Viberr's own controller, asked where a human-supplied artifact
 * would genuinely help this project, named the task and the file and explained
 * why — "a human-supplied fixture stops the decoder from being tested against a
 * fixture it wrote for itself" — and the only way to do it was writing into the
 * server's data volume by hand.
 *
 * Contributor-and-above (`attach-file`), the same tier that grooms a task's
 * metadata and for the same reason: it adds evidence and changes no gate. The
 * writer refuses a traversing or dot-prefixed name, an extension this product
 * can neither render nor read back, and anything over the size cap. An archived
 * task takes no attachments, like every other edit.
 */
export async function attachTaskFile(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    name: string;
    data: Uint8Array;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ attachment: WrittenAttachment }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "attach-file", "attach a file to a task");
  const ref = taskRef(ctx, input.projectSlug, input.taskKey);
  const existing = readTaskFile(ref);
  if (!existing) {
    throw AppError.notFound(`No task ${input.taskKey} in ${input.projectSlug}.`);
  }
  if (existing.parsed.frontmatter.archived) {
    throw AppError.validation(
      `${input.taskKey} is archived. Restore it before attaching a file.`,
    );
  }
  // A file an agent run saved can be the work under review (ruling 388 binds
  // a review to a deliverer's saved files by WHEN they were saved, not by
  // their bytes), so a person's upload never overwrites one: the approval
  // would stand on content no reviewer read. Their own files they may replace.
  // Ruling 675: compared composed, as the store resolves the name, so the
  // same name sent in the other Unicode form is still the agent's file.
  const name = storedFileName(input.name.trim());
  const agentSaved = existing.parsed.timeline.some(
    (e) => e.actor.kind === "agent" && (e.attachments ?? []).some((held) => storedFileName(held) === name),
  );
  // Ruling 558: the name is held from before the file lands until the note
  // claims it, so a run completing meanwhile never takes it as its own, and a
  // note that cannot be written takes the file back up.
  const attachment = await withAttachmentClaims(
    input.projectSlug,
    input.taskKey,
    [checkAttachmentUpload(input.name, input.data.byteLength)],
    async (put) => {
      const written = put(
        input.name,
        input.data,
        agentSaved
          ? `“${name}” is a file an agent run saved on ${input.taskKey}, and it may be the work under review. Attach yours under another name.`
          : null,
      );
      await updateTaskFile(ref, (parsed) => {
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "note",
          actor: humanActorRef(db, actor),
          title: "Attachment added",
          text:
            `Attached \`${written.name}\` (${attachmentKb(written.bytes)})` +
            `${written.replaced ? ", replacing a file of the same name" : ""}. ` +
            "Agents on this task read it from the task's attachments.",
          toAgent: false,
          evidence: null,
          // Ruling 533: the note claims the file for the person, so the panel says
          // who added it and a run in flight is never credited with it.
          attachments: [written.name],
        });
      });
      return written;
    },
    ctx.dataRoot,
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.attachment.added",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      name: attachment.name,
      bytes: attachment.bytes,
      replaced: attachment.replaced,
    },
  });
  return { attachment };
}

/**
 * Ruling 582: a project admin takes a file off a task's record.
 *
 * Round 1 of the AWS calculator board left its answer key, `golden-files.md`,
 * in AWSC-3's attachments, where every agent's shell and every `read_board` of
 * that task can read it, and round 3 re-runs the same samples. Nothing short of
 * a shell in the container could remove it.
 *
 * The file goes, and so does its name on every entry that claimed it, so no
 * tile on the timeline opens nothing. A note says who removed what and why;
 * the audit row keeps the name and the size. An archived task allows it: what
 * has to come off the record comes off whatever the task's state.
 */
export async function removeTaskAttachment(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; name: string; reason: string | null },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ name: string; bytes: number }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "remove-from-record", "remove a file from a task");
  const name = input.name.trim();
  const missing = () => AppError.notFound(`${input.taskKey} has no attachment “${name}”.`);
  let abs: string;
  let bytes: number;
  try {
    abs = resolveTaskAttachment(input.projectSlug, input.taskKey, name, ctx.dataRoot);
    const stat = lstatSync(abs);
    if (stat.isDirectory()) throw missing();
    bytes = stat.size;
  } catch {
    throw missing();
  }
  const reason = input.reason?.trim() || null;
  // Ruling 675: a claim is this file's when it names it as the store finds it,
  // in either Unicode form, so no tile is left that opens nothing. A folder
  // that holds both forms as two files keeps the other one's claims.
  const stored = path.basename(abs);
  const held = [...new Set([...listTaskAttachmentNames(input.projectSlug, input.taskKey, ctx.dataRoot), stored])];
  const claimsIt = (claim: string) => storedNameAmong(held, claim) === stored;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    for (const event of parsed.timeline) {
      if (event.attachments?.some(claimsIt)) {
        event.attachments = event.attachments.filter((claim) => !claimsIt(claim));
      }
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "note",
      actor: humanActorRef(db, actor),
      title: "Attachment removed",
      text:
        `Removed \`${name}\` (${attachmentKb(bytes)}) from this task's attachments.` +
        (reason ? ` Why: ${endSentence(reason)}` : ""),
      toAgent: false,
      evidence: null,
    });
    // Last, so a file that cannot be removed leaves the task file unwritten.
    unlinkSync(abs);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.attachment.removed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { name, bytes, reason },
  });
  return { name, bytes };
}

/**
 * Edit the lightweight planning metadata (priority, labels, due date).
 *
 * Distinct from `updateTaskGoal`: the goal is the reviewable acceptance
 * contract, so a human editing it re-anchors every downstream agent and clears
 * scope packets. Metadata changes NO gate and NO agent's instructions, so this
 * writes the frontmatter, reprojects, audits, and stops — no operator re-invoke.
 * A `patch` only touches the fields it names (partial update), so the create
 * form, the board, and the detail panel can each set one axis independently.
 *
 * `urgent` is kept as a derived mirror of `priority === "urgent"` so the board
 * highlight / "risk" filter that read it keep agreeing with the graded scale.
 */
export async function setTaskMetadata(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    priority?: TaskPriority;
    labels?: readonly string[];
    dueDate?: string | null;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "edit-task-meta", "edit task metadata");

  // Validate + normalize every provided axis up front, so a bad value fails the
  // whole edit before any file write (never a half-applied patch).
  const patch: TaskMetadataPatch = {};
  if (input.priority !== undefined) {
    if (!PRIORITY_VALUES.includes(input.priority)) {
      throw AppError.validation(`Unknown priority "${input.priority}".`);
    }
    patch.priority = input.priority;
  }
  if (input.labels !== undefined) {
    patch.labels = normalizeTaskLabels(input.labels);
  }
  if (input.dueDate !== undefined) {
    const raw = input.dueDate?.trim() ?? "";
    if (raw === "") {
      patch.dueDate = null;
    } else if (isValidDueDate(raw)) {
      patch.dueDate = raw;
    } else {
      throw AppError.validation(
        `Due date must be a calendar date (YYYY-MM-DD); got "${input.dueDate}".`,
      );
    }
  }

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const fm = existing.parsed.frontmatter;

  // F26-13: an archived task is abandoned work kept for the record — its planning
  // metadata is frozen. (This guard existed before the metadata editor moved into
  // the Details panel and was lost in that move; restore it, and fail CLOSED here
  // even if a client renders the editor on an archived task.)
  if (fm.archived) {
    throw AppError.validation(
      `${input.taskKey} is archived. Restore it before editing its priority, labels or due date.`,
    );
  }

  // No-op guard: if every provided axis already holds its target value, skip the
  // write (mirrors updateTaskGoal's equality short-circuit).
  const priorityChanges =
    patch.priority !== undefined && patch.priority !== fm.priority;
  const labelsChange =
    patch.labels !== undefined &&
    JSON.stringify(patch.labels) !== JSON.stringify(fm.labels);
  const dueChanges =
    patch.dueDate !== undefined && patch.dueDate !== fm.dueDate;
  if (!priorityChanges && !labelsChange && !dueChanges) {
    return { task: summaryOrThrow(db, input.projectSlug, input.taskKey) };
  }

  const changed: string[] = [];
  if (priorityChanges) changed.push(`priority → ${patch.priority}`);
  if (labelsChange) {
    changed.push(
      patch.labels && patch.labels.length > 0
        ? `labels → ${patch.labels.join(", ")}`
        : "labels cleared",
    );
  }
  if (dueChanges) {
    changed.push(patch.dueDate ? `due ${patch.dueDate}` : "due date cleared");
  }

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    const f = parsed.frontmatter;
    if (patch.priority !== undefined) {
      f.priority = patch.priority;
      // Keep the derived `urgent` rung in lock-step with the graded scale.
      f.urgent = patch.priority === "urgent";
    }
    if (patch.labels !== undefined) f.labels = patch.labels;
    if (patch.dueDate !== undefined) f.dueDate = patch.dueDate;
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "note",
      actor: humanActorRef(db, actor),
      title: "Task metadata updated",
      text: `Planning metadata changed: ${changed.join(" · ")}.`,
      toAgent: false,
      evidence: null,
    });
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  const details: TaskMetadataPatch = {};
  if (priorityChanges) details.priority = patch.priority;
  if (labelsChange) details.labels = patch.labels;
  if (dueChanges) details.dueDate = patch.dueDate;
  recordAudit(db, {
    action: "task.metadata.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details,
  });
  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey) };
}

/**
 * Ruling 295: the longest task title, and the length a refusal names.
 *
 * 200 characters is well past any title a person writes and short of the point
 * where a board card stops being scannable. There is no cap on creation today,
 * so this bounds only what a RENAME may set: a task that arrived with a longer
 * title keeps it until someone edits it, and is then held to this.
 */
const TASK_TITLE_MAX_CHARS = 200;

/**
 * Ruling 295 (pass 37, F37-130): a task's TITLE can be corrected.
 *
 * It could not be, by anyone. `updateTaskGoal` writes the goal — the contract
 * every future run re-anchors on (ruling 189) — and nothing anywhere wrote the
 * one-line summary of it. Not the controller, not the task page, not an
 * operator. A title was whatever it was at creation, permanently.
 *
 * The controller found it and put the cost plainly, about a title it had
 * written itself: "Its own run measured both halves of its title false … What I
 * wanted: change six words in the title I wrote. What I did instead: rewrote the
 * entire 6,000-character goal to say the premise is contested, and then told you
 * 'that one needs you on the task page' — twice, in two consecutive turns …
 * The title is what every person scanning the board reads; the correction lives
 * in a body almost nobody opens. A false claim I authored is still on the board
 * an hour after being disproved."
 *
 * There was no safety in the omission. A title is display prose: the KEY is the
 * stable reference (`SHOP-50`), the branch is derived from the key at first
 * dispatch (ruling 122), and a pull request is titled from the commit subject.
 * Nothing downstream is pinned to these words. So the gate is the goal's own —
 * a title and a goal are the same claim at two lengths, and it would be strange
 * for the shorter one to be harder to correct than the longer.
 *
 * The rename is NOTED, and that is not ceremony: a title is how people refer to
 * a task out loud and in other documents, so a silent rename makes every
 * existing reference to the old words look like a reference to something else.
 * The note carries both, which is what lets a reader join them.
 */
export async function updateTaskTitle(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; title: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary; changed: boolean }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(db, project, actor, "update-goal", "edit the task title");
  const title = input.title.trim().replace(/\s+/g, " ");
  if (title.length < 3) {
    throw AppError.validation("A title of at least 3 characters is required.");
  }
  if (title.length > TASK_TITLE_MAX_CHARS) {
    // Ruling 288's rule, one field over: a contract Viberr will not write half
    // of. A title is the one string every board card, every review-queue row
    // and every epic's task list renders, so a silently cut one is wrong in
    // more places than a cut goal.
    throw AppError.validation(
      `A title is at most ${TASK_TITLE_MAX_CHARS} characters and this one is ${title.length}. ` +
        "Nothing was written. Shorten it: the detail belongs in the goal, which has room.",
    );
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const before = existing.parsed.frontmatter.title;
  if (before.trim() === title) {
    return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), changed: false };
  }
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.title = title;
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "note",
      actor: humanActorRef(db, actor),
      title: "Title updated",
      // BOTH titles, because the old one is what every existing reference to
      // this task says — in a comment, another task's goal, a person's memory.
      text:
        `Renamed from "${before}" to "${title}". The task key is unchanged, so ` +
        `references to ${input.taskKey} still resolve; references by the old ` +
        `wording are this task.`,
      toAgent: false,
      evidence: null,
    });
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.title.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { from: before, to: title },
  });
  return { task: summaryOrThrow(db, input.projectSlug, input.taskKey), changed: true };
}
