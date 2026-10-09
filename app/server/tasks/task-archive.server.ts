/**
 * Archiving a task and restoring it (ruling 13(a)). Archiving is a disposition,
 * not a delete: the task leaves the board's default view and the review queue,
 * its open decisions are withdrawn, and a restore puts it back where it stood.
 */

import type { DatabaseSync } from "node:sqlite";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { maybeReleaseDependents, noteDeadDependency } from "./dependencies.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  loadProjectContext,
  reprojectTask,
  summaryOrThrow,
  type TaskActor,
  type TaskMutationContext,
  taskRef,
} from "./task-mutation.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { maybeNoteEpicComplete } from "./epic-actions.server";
import {
  type ClosedDecision,
  followClosedDecision,
  markTaskPacketApprovalRead,
} from "~/server/projections/notifications.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { logger } from "~/server/logging/logger.server";
import { toError } from "~/shared/errors";
import {
  humanActorRef,
  interruptLiveRunsOnClosure,
  requireAction,
  stageName,
} from "./task-action-core.server";

/**
 * R14-3 (owner ruling 2026-07-25) — archive / restore ONE task.
 *
 * The honest ending for work that is abandoned rather than delivered: a PR the
 * team closed on GitHub, a duplicate, a task the goal moved past. The product
 * has been TELLING humans to do this for a pass — `closedPrBlockedReason` says
 * "Rework and reopen the PR, or archive the task" — while no task-level archive
 * existed anywhere (P14-GV-02); the only real escapes were an admin force-accept
 * (which lies: nothing was accepted) or leaving the card on the board forever.
 *
 * Contract:
 *  - the task file stays put and the whole timeline survives — archiving is a
 *    disposition, not a delete;
 *  - archived tasks leave the board's default view and the review queue, and
 *    stop counting as open decisions (the open packet + pending recommendations
 *    are withdrawn here, recorded in the archive note, because nobody is waiting
 *    on abandoned work);
 *  - it is reversible: restoring puts the task back where it stood, waiting on a
 *    human to decide what happens next;
 *  - authority mirrors the board-management tier (`approve-transition`,
 *    admin|maintainer) — the same authority that moves a task between stages
 *    decides that it leaves the flow. Archived PROJECTS are frozen upstream by
 *    `requireAction`'s R6-3 gate, so a task inside one can't be archived either.
 */
export async function setTaskArchived(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; archived: boolean },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<{ task: TaskSummary; archived: boolean; toast: string }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  requireAction(
    db,
    project,
    actor,
    "approve-transition",
    input.archived ? "archive this task" : "restore this task",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (existing.parsed.frontmatter.archived === input.archived) {
    // Idempotent: no second timeline note, no misleading audit row.
    return {
      task: summaryOrThrow(db, input.projectSlug, input.taskKey),
      archived: input.archived,
      toast: input.archived
        ? `${input.taskKey} is already archived.`
        : `${input.taskKey} is not archived.`,
    };
  }

  const withdrawn = input.archived
    ? [
        ...(existing.parsed.packet ? [`the open “${existing.parsed.packet.title}” decision`] : []),
        ...existing.parsed.frontmatter.recommendations.map((r) => `“${r.label}”`),
      ]
    : [];
  // F20-25: the archive discards the packet (its options are gone), so restore
  // cannot literally re-open the SAME decision — it hands the task back to a
  // human, who runs the operator to re-open coordination. The note used to
  // promise "restore … to reopen the question", which left a restored task
  // stranded on "Waiting on: Human decision" with no decision to act on; say
  // what restore actually does instead.
  const withdrawnNote =
    withdrawn.length > 0
      ? ` ${withdrawn.join(", ")} ${withdrawn.length === 1 ? "was" : "were"} withdrawn. Restoring the task brings it back to a human, who can run the operator to reopen the decision.`
      : "";

  // Ruling 52: a task restored at the terminal stage is finished work. Ruling
  // 274 archives done tasks too, and restoring one said it was "waiting on a
  // human" with a next step to take, over work nobody has anything left to do
  // on (live: AWSC-3, restored at Done so a later run could take a file).
  const restoredDone =
    !input.archived && isTerminalStage(existing.parsed.frontmatter.stage, project.stages);

  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    // Neutral disposition, not a governance violation (P13-LV-03).
    type: "note",
    actor: humanActorRef(db, actor),
    title: null,
    text: input.archived
      ? `**Archived:** ${input.taskKey} was archived. It leaves the board and the review queue, and its record is kept.${withdrawnNote}`
      : restoredDone
        ? `**Restored:** ${input.taskKey} was restored from the archive and is back on the board. It is done, so nothing waits on it.`
        : // F20-25: a restored task waits on a human but carries no decision object
          // — name the next step so it is not stranded on a silent "Human decision".
          `**Restored:** ${input.taskKey} was restored from the archive and is back on the board, waiting on a human. Run the operator to reopen coordination, or move the task on yourself.`,
    toAgent: false,
    evidence: null,
  };

  /** Ruling 75: the decision the archive withdrew, recorded by its note. */
  let archivedPacket: ClosedDecision | null = null;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.archived = input.archived;
    if (input.archived) {
      // Nothing waits on abandoned work: withdraw the open decision so the
      // inbox, the board chip and the review queue stop asking for one.
      parsed.frontmatter.waiting = "none";
      parsed.frontmatter.recommendations = [];
      if (parsed.packet) {
        archivedPacket = { packetId: parsed.packet.id, closedAt: event.occurredAt };
      }
      parsed.packet = null;
      // P14-RV-03: and the SCHEDULES. Withdrawing the packet and the
      // recommendations but leaving a pending operator re-run behind meant the
      // one thing archiving failed to stop was the one thing that acts with no
      // human watching (FR39). The runner also treats an archived task as moot,
      // so this is belt-and-braces for a task archived by a file edit.
      parsed.frontmatter.schedules = parsed.frontmatter.schedules.map((s) =>
        s.status === "pending" || s.status === "claimed"
          ? { ...s, status: "cancelled" as const }
          : s,
      );
    } else {
      // A restored task is back in a human's hands — it has no agent in flight
      // and no decision object, so the honest wait state is "human". A done
      // task waits on nobody (ruling 52).
      parsed.frontmatter.waiting = restoredDone ? "none" : "human";
    }
    parsed.timeline.unshift(event);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
  if (archivedPacket) followClosedDecision(db, input.projectSlug, input.taskKey, archivedPacket);
  // Ruling 154 (pass 36): archiving closes the task — its live runs end too.
  if (input.archived) {
    await interruptLiveRunsOnClosure(db, ctx, input.projectSlug, input.taskKey, actor, {
      cause: "archive",
    });
  }

  recordAudit(db, {
    action: input.archived ? "task.archived" : "task.unarchived",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details:
      withdrawn.length > 0
        ? {
            stage: existing.parsed.frontmatter.stage,
            withdrawn: withdrawn.length,
          }
        : { stage: existing.parsed.frontmatter.stage },
  });

  // Ruling 57: a dependent waiting on THIS task can never be released by
  // it now. Noted once on each dependent (and its watchers told) BEFORE the
  // archive returns, so the person who archived sees the consequence at once.
  if (input.archived) {
    try {
      await noteDeadDependency(db, ctx, input.projectSlug, input.taskKey);
    } catch (error) {
      logger.warn("dead-dependency notice failed", {
        taskKey: input.taskKey,
        err: toError(error),
      });
    }
  }

  // Ruling 55: archiving the last OPEN task of an epic leaves every task in
  // it done. Archiving a done task, or restoring one, completes nothing new.
  if (input.archived && !isTerminalStage(existing.parsed.frontmatter.stage, project.stages)) {
    maybeNoteEpicComplete(db, ctx, input.projectSlug, input.taskKey);
  }
  // Ruling 57: a restore can satisfy a dependent's wait again.
  maybeReleaseDependents(db, ctx, input.projectSlug);

  return {
    task: summaryOrThrow(db, input.projectSlug, input.taskKey),
    archived: input.archived,
    toast: input.archived
      ? `${input.taskKey} archived. Find it under Archived on the board.`
      : `${input.taskKey} restored to ${stageName(project, existing.parsed.frontmatter.stage)}.`,
  };
}
