/**
 * Who owns a task (ruling 654): taking or assigning the owner seat, releasing
 * it, and releasing every task a departing member owned. The owner is the
 * task's acceptance authority and the person its agent runs bill (ruling 127).
 */

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { roleCan } from "~/shared/rbac";
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
import {
  appendTimelineEvent,
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { userDisplayName } from "./user-display-name.server";
import {
  humanActorRef,
  ownerAssignEvent,
  requireAction,
  requireAnyMember,
  requireOwnable,
  terminalStageIdOf,
} from "./task-action-core.server";

/**
 * Take or hand off ownership. Exact typed `assign` event copy from
 * task-detail spec §5.2.
 *
 * RBAC, as enforced below: taking requires `own-task` — admin, maintainer and
 * contributor, NOT all four roles; a viewer is read+comment only and cannot
 * hold the owner seat. (The docblock claimed "any project member may take (all
 * four roles hold …)" since before the Q5 tiering removed viewers from that
 * grant; the code has been refusing them the whole time.) Handing off requires
 * being the current owner or holding `release-any-ownership`, and the target
 * must be a member who can own.
 */
export async function setOwner(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; targetUserId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<TaskSummary> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const actorRole = requireAction(
    db,
    project,
    actor,
    "own-task",
    "take or assign task ownership",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const currentOwnerId = existing.parsed.frontmatter.ownerUserId;

  // D32-16 (pass 32): an archived task is out of the flow (F15-11) and its
  // planning metadata is frozen (F26-13); the owner seat — the task's human
  // reviewer and acceptance authority — is frozen the same way. The panels
  // hide "Assign me" on an archived task; this fails CLOSED if one does not.
  if (existing.parsed.frontmatter.archived) {
    throw AppError.validation(
      `${input.taskKey} is archived. Restore it before changing its owner.`,
    );
  }
  // E32-9 / ruling 118 (owner, 2026-09-02): a task at the terminal stage is
  // CLOSED — every runtime control on its page says so (G9) — and the owner
  // seat's authority (review, acceptance, packet resolution) has nothing left
  // to act on. Contributors and maintainers cannot take it; a project ADMIN may
  // still reassign it for the record (the same tier that releases any owner).
  // A reopened task (moved back to an open stage) takes owners again.
  const terminalId = terminalStageIdOf(project);
  if (
    terminalId !== null &&
    existing.parsed.frontmatter.stage === terminalId &&
    !roleCan(actorRole, "release-any-ownership")
  ) {
    throw AppError.validation(
      `${input.taskKey} is closed. Move it back to an open stage before changing its owner (an admin can still reassign it for the record).`,
    );
  }

  const isTake = input.targetUserId === actor.userId;
  // A TAKEOVER of an OCCUPIED seat (claiming a task another member owns) is the
  // governance hole: ownership carries the owner-exception
  // (`requireAcceptCompletion` / `requireDecisionAuthority`), so a CONTRIBUTOR
  // who seized an owned task would gain accept-completion + resolve-packet
  // authority on it that their role does not otherwise grant. A maintainer/admin
  // already holds that authority, so their takeover escalates nothing (and is a
  // legitimate supervisory reassignment). So a takeover of an occupied seat is
  // gated on ALREADY holding acceptance authority; claiming an OPEN seat, or
  // re-taking your own (the idempotent case below), stays `own-task`
  // (contributor+).
  if (
    isTake &&
    currentOwnerId &&
    currentOwnerId !== actor.userId &&
    !roleCan(actorRole, "accept-completion")
  ) {
    throw AppError.forbidden(
      "This task already has an owner. Taking it over needs completion-acceptance authority (maintainer or admin); ask them to reassign it.",
    );
  }
  if (!isTake) {
    // Hand off: current owner, or the tier that may manage OTHERS' ownership
    // (`release-any-ownership` — admin today, single-sourced in ACTION_ROLES
    // instead of a hardcoded role literal); target must be able to OWN
    // (contributor+ — a viewer is read+comment only and can't hold the owner seat).
    if (currentOwnerId !== actor.userId && !roleCan(actorRole, "release-any-ownership")) {
      throw AppError.forbidden("Only the current owner or a project admin can hand off ownership.");
    }
    requireOwnable(project, input.targetUserId);
  }

  if (currentOwnerId === input.targetUserId) {
    // Idempotent: already the owner — no duplicate event.
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }

  let text: string;
  if (isTake && !currentOwnerId) {
    text =
      "Took task ownership. The owner is the human reviewer and acceptance authority for this task.";
  } else if (isTake) {
    text = `Took over task ownership from **${userDisplayName(db, currentOwnerId!)}**. The owner is the human reviewer and acceptance authority.`;
  } else {
    text = `Handed task ownership to **${userDisplayName(db, input.targetUserId)}**. They hold review & acceptance for this task now.`;
  }

  const event = ownerAssignEvent(db, actor, text);

  await appendTimelineEvent(taskRef(ctx, input.projectSlug, input.taskKey), event, {
    ownerUserId: input.targetUserId,
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  // Ruling 140(b): tell the person whose seat changed — the new owner on a
  // hand-off, the DISPLACED owner on a takeover. Losing the seat takes away
  // the credential principal role, the review duty and the acceptance
  // authority, so it is not a smaller fact than gaining it. Nobody is told
  // about their own act. The notifier runs BEFORE the audit row so the row can
  // say whether the person was told, and why not when they were not.
  // Both sides, independently. Choosing ONE recipient by `isTake` left a
  // third-party hand-off (an admin moving the seat between two other people,
  // which the gate above admits) telling the new owner and nobody else: the
  // displaced owner lost the credential principal role, the review duty and
  // the acceptance authority in silence, and the audit row named the wrong
  // person as the one told (pass 34 review).
  const actorName = userDisplayName(db, actor.userId);
  const notified = notifyOwnerSeatChange(db, {
    projectSlug: input.projectSlug,
    recipientUserId: input.targetUserId,
    actor,
    actorName,
    change: { kind: "handed_off", taskKey: input.taskKey },
    eventAt: event.occurredAt,
  });
  const displaced =
    currentOwnerId && currentOwnerId !== input.targetUserId
      ? notifyOwnerSeatChange(db, {
          projectSlug: input.projectSlug,
          recipientUserId: currentOwnerId,
          actor,
          actorName,
          change: { kind: "taken_over", taskKey: input.taskKey },
          eventAt: event.occurredAt,
        })
      : null;
  const ownershipDetails: NonNullable<AuditEventInput["details"]> = {
    previousOwnerUserId: currentOwnerId,
    newOwnerUserId: input.targetUserId,
  };
  if (notified) ownershipDetails.notified = notified;
  if (displaced) ownershipDetails.notifiedDisplaced = displaced;
  recordAudit(db, {
    action: isTake ? "task.ownership.taken" : "task.ownership.handed_off",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: ownershipDetails,
  });

  // Ownership is a human bookkeeping action (claiming the review/acceptance
  // seat) — deliberately orthogonal to operator scheduling, so the operator is
  // NOT auto-invoked here. It is driven by its real lifecycle triggers (task
  // creation, stage transitions, goal updates, @mentions, and the explicit
  // "Run operator" control). The former reaction (a ready/agent flip + a
  // synthesized "scheduling execution" narration + a fire-and-forget run) only
  // animated the seeded VIB-148 demo — its trigger was a hardcoded
  // `**Quality gate:**` text match the real operator never emits — and was
  // removed with that mock stand-in (F19).

  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}

/**
 * Release ownership. Any member releases their own seat; project admins
 * may release anyone (recorded as an admin action in audit + event copy).
 */
export async function releaseOwner(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<TaskSummary> {
  const project = loadProjectContext(ctx, input.projectSlug);

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const currentOwnerId = existing.parsed.frontmatter.ownerUserId;

  if (!currentOwnerId) {
    // Idempotent: nothing to release. Still require membership so a non-member
    // can't probe task state through this path.
    requireAnyMember(db, project, actor, "release task ownership");
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }

  const isSelf = currentOwnerId === actor.userId;
  if (isSelf) {
    // Releasing your OWN seat: needs the own-task capability (contributor+).
    requireAction(db, project, actor, "own-task", "release task ownership");
  } else {
    // Releasing SOMEONE ELSE's seat: admin only (release-any-ownership).
    requireAction(db, project, actor, "release-any-ownership", "release another member's ownership");
  }

  // F19-11 (third instance) — "the seat is open to any project member" is the
  // same RBAC misdescription the Execution profile carried: `own-task` is
  // admin|maintainer|contributor (`app/shared/rbac.ts:65`, the single source),
  // and a VIEWER is a project member who can never take the seat. The UI half
  // was corrected to "a contributor or above can take it"; this timeline event
  // is the server half, read by exactly the same humans.
  const text = isSelf
    ? "Released task ownership. Review & acceptance stall until another member takes the seat."
    : `Released **${userDisplayName(db, currentOwnerId)}** from task ownership (admin). The seat is open to any contributor or above.`;

  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "assign",
    actor: humanActorRef(db, actor),
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };

  await appendTimelineEvent(taskRef(ctx, input.projectSlug, input.taskKey), event, { ownerUserId: null });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  // Ruling 140(b): an ADMIN release takes the seat away from someone; they are
  // told, in the same shape a hand-off uses. A self-release notifies nobody.
  const releaseNotified = isSelf
    ? null
    : notifyOwnerSeatChange(db, {
        projectSlug: input.projectSlug,
        recipientUserId: currentOwnerId,
        actor,
        actorName: userDisplayName(db, actor.userId),
        change: { kind: "admin_released", taskKey: input.taskKey },
        eventAt: event.occurredAt,
      });
  const releaseDetails: NonNullable<AuditEventInput["details"]> = {
    previousOwnerUserId: currentOwnerId,
    forced: !isSelf,
  };
  if (releaseNotified) releaseDetails.notified = releaseNotified;
  recordAudit(db, {
    action: isSelf ? "task.ownership.released" : "task.ownership.admin_released",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: releaseDetails,
  });

  return summaryOrThrow(db, input.projectSlug, input.taskKey);
}

/** A row from `task_projections` naming a task with a projected human owner. */
const ownedTaskKeyRow = z.object({ task_key: z.string() });

/**
 * A3 (pass 23): release every task a departing member OWNS in one project.
 *
 * Removing a member from a project — or deleting their org account — dropped
 * them from `members[]` and stopped there, leaving every task they OWNED
 * pointing at an `ownerUserId` that is no longer a member. The board resolved a
 * GHOST owner and review/acceptance stalled on a seat nobody could fill, while
 * both removal dialogs promised the seat was handled ("returns to the operator
 * for reassignment") — it was not touched at all. Ownership is a HUMAN seat that
 * `setOwner` keeps deliberately orthogonal to the operator, so the honest
 * response is to RELEASE the seat — the same clear-to-null `releaseOwner`
 * performs — so a contributor+ can take it. Returns how many tasks were freed.
 *
 * Best-effort per task: a task that vanished or was re-owned between the
 * projection read and the write is skipped, never fatal to the removal that
 * triggered it. Archived tasks are left alone — they sit off every active board
 * and queue, so a ghost owner there blocks nothing; a restore re-opens ownership
 * the normal way. Enumerated from the projection (the board's own owner index),
 * re-checked against the authoritative task file inside the write lock.
 */
export async function releaseTasksOwnedBy(
  db: DatabaseSync,
  input: { projectSlug: string; userId: string; removedName: string },
  actor: { userId: string | null; label: string },
  ctx: TaskMutationContext = {},
): Promise<number> {
  const keys = db
    .prepare(
      `SELECT task_key FROM task_projections
        WHERE project_slug = ? AND owner_user_id = ? AND archived = 0`,
    )
    .all(input.projectSlug, input.userId)
    .flatMap((row) => {
      const parsed = ownedTaskKeyRow.safeParse(row);
      return parsed.success ? [parsed.data.task_key] : [];
    });

  let released = 0;
  for (const taskKey of keys) {
    const ref = taskRef(ctx, input.projectSlug, taskKey);
    const existing = readTaskFile(ref);
    // Projection can lag the file (a re-owned or deleted task): trust the file.
    if (!existing || existing.parsed.frontmatter.ownerUserId !== input.userId) {
      continue;
    }
    const event: TaskFileEvent = {
      occurredAt: new Date().toISOString(),
      type: "assign",
      actor: { kind: "system", systemId: "membership" },
      title: null,
      text: `**${input.removedName}** was removed from the project, releasing task ownership. The seat is open for any contributor or above to take; review & acceptance stall until someone does.`,
      toAgent: false,
      evidence: null,
    };
    let changed = false;
    await updateTaskFile(ref, (parsed) => {
      if (parsed.frontmatter.ownerUserId !== input.userId) return;
      parsed.frontmatter.ownerUserId = null;
      parsed.timeline.unshift(event);
      changed = true;
    });
    if (!changed) continue;
    reprojectTask(db, ctx, input.projectSlug, taskKey);
    recordAudit(db, {
      action: "task.ownership.released_on_removal",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug: input.projectSlug,
      taskKey,
      details: { previousOwnerUserId: input.userId },
    });
    released += 1;
  }
  return released;
}
