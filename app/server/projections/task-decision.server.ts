import type { DatabaseSync } from "node:sqlite";
import {
  activeWorkRevision,
  deliveredAsFiles,
  type Recommendation,
} from "~/schemas/task-file.schema";
import { taskAttachmentExists } from "~/server/files/task-attachments.server";
import { readTaskFile, type TaskFileReadResult } from "~/server/files/task-writer.server";
import { readTaskSources, type TaskSourcesRead } from "~/server/files/task-sources.server";
import { findUserById } from "~/server/auth/user-store.server";
import { githubWebHost } from "~/server/github/github-client.server";
import { logger } from "~/server/logging/logger.server";
import { createReconcileBehindByLookup } from "~/server/provenance/provenance-query.server";
import { userBackendHealth } from "~/server/runtimes/backend-credentials.server";
import { listRunsForTaskRows } from "~/server/runtimes/run-store.server";
import { completionView, sourcesRestedOn, type CompletionView } from "~/server/tasks/completion-packet.server";
import {
  causeFanOutDisclosure,
  siblingPacketsSharingCause,
} from "~/server/tasks/packet-fanout.server";
import { getMentionables, type Mentionables } from "~/server/tasks/mention-suggestions.server";
import { similarOpenTasks } from "~/server/tasks/similar-tasks.server";
import { listDeployedSpecialists } from "~/server/tasks/specialist-roster.server";
import {
  acceptanceStanding,
  type AcceptanceAffordance,
  type AcceptanceStanding,
} from "~/server/tasks/task-acceptance.server";
import { whatItTook, type TookCard, type TookShipped } from "~/server/tasks/what-it-took.server";
import type { ProjectRecord } from "~/shared/mapping/project.server";
import { toError } from "~/shared/errors";
import type { PrOverlap } from "~/shared/pr-overlaps";
import type { TaskRunPrincipalView } from "~/features/task-detail/run-principal-view";
import type { ProjectRole } from "~/shared/rbac";
import { stageName } from "~/shared/workflow/stage-roles";
import { getProject, listProjectMembers } from "./board-query.server";
import { taskMergeCollisions } from "./pr-collisions.server";
import { getTaskDetail, type TaskDetail } from "./task-query.server";

/**
 * The open decision on one task, as a person reads it before they answer:
 * the packet's disclosures, the completion it offers, the facts the
 * acceptance ceremony names, and whose accounts the comment composer's agent
 * mentions would bill. Two readers, one reading: the task page's loader
 * (`routes/project.task.tsx`) and the Review queue's decision dialog (ruling
 * 304, `routes/task-decision.ts`), so the dialog cannot show a decision the
 * task page would draw differently.
 */

/** Ruling 67: a task whose title already looks like what a `create_task`
 *  option would make. */
export interface SimilarTaskEcho {
  key: string;
  title: string;
  stage: string;
}

/** What `taskDecisionReads` adds to what its caller has already read. */
export interface TaskDecisionReads {
  /** Ruling 65: what else the open packet's confirm answers, or null. */
  packetAlsoAnswers: string | null;
  /** Ruling 67: per `create_task` option index, the tasks that already look
   *  like the one it would create. */
  packetCreateTaskEchoes: Record<number, SimilarTaskEcho[]>;
  /** R15-1: the delivered revision the accept dialog names as what merges. */
  workRevisionSha: string | null;
  /** R17-2: a verified no-change completion (empty branch, no PR). */
  noChanges: boolean;
  /** Ruling 316: when the task was delivered as files, the delivery's time.
   *  Spread into a payload, so a task delivered otherwise ships no key. */
  filesDelivery: { filesDeliveredAt?: string };
  /** The merge target the accept dialog names: the project's default branch. */
  defaultBranch: string;
  /** Ruling 244: the other open PRs this task's merge would likely put in
   *  conflict. */
  mergeCollisions: PrOverlap[];
  /** Ruling 103: the operator's completion packet as the page shows it. */
  completion: CompletionView | null;
  /** Ruling 83: what the task took, spread beside the completion it rides. */
  tookShipped: TookShipped;
}

/**
 * The decision's reads, from what the caller has already read: the task page
 * reads these inputs for its other panels too, so taking them as arguments is
 * what keeps its statement count where ruling 11 measures it. Each disclosure
 * is guarded: a read that fails costs its sentence, never the page.
 */
export function taskDecisionReads(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    detail: TaskDetail;
    taskFile: TaskFileReadResult | null;
    project: ProjectRecord | null;
    archived: boolean;
    standing: AcceptanceStanding;
    keptSources: TaskSourcesRead;
    deployedSpecialists: readonly { id: string; name: string }[];
    runRows: ReturnType<typeof listRunsForTaskRows>;
  },
): TaskDecisionReads {
  const { projectSlug, taskKey, detail, taskFile, project, archived, standing } = input;
  const fm = taskFile?.parsed.frontmatter;

  /**
   * Ruling 65: this packet's `cause` says the failure that raised it belongs
   * to an ACCOUNT, not to this task — so confirming here also answers every
   * sibling packet the same failure raised. A decision that reaches four other
   * tasks and says nothing about it on the card is precisely the un-disclosed
   * one-way write ruling 97 exists to stop; the disclosure is computed here,
   * beside the acceptance disclosure, and rendered above the options.
   */
  const packetCause = taskFile?.parsed.packet?.cause;
  let packetAlsoAnswers: string | null = null;
  if (packetCause) {
    try {
      packetAlsoAnswers = causeFanOutDisclosure(
        siblingPacketsSharingCause(db, packetCause, { projectSlug, taskKey }),
        packetCause,
      );
    } catch (error) {
      logger.warn("ruling 65 fan-out disclosure failed", {
        projectSlug,
        taskKey,
        error: toError(error),
      });
    }
  }

  /**
   * Ruling 67: a `create_task` option creates a real task on the person's
   * confirm, and the card says what it will create without saying what already
   * looks like it. Twice on the shopify-clone board a confirm was one click
   * from a second owner for work a live task already held.
   *
   * Per option index, because a packet can carry more than one, and the person
   * is choosing between them.
   */
  const packetCreateTaskEchoes: Record<number, SimilarTaskEcho[]> = {};
  for (const [i, opt] of (taskFile?.parsed.packet?.options ?? []).entries()) {
    if (opt.kind !== "create_task" || !opt.newTask) continue;
    try {
      const echoes = similarOpenTasks(db, projectSlug, opt.newTask.title, [taskKey]);
      if (echoes.length > 0) {
        packetCreateTaskEchoes[i] = echoes.map((e) => ({
          key: e.key,
          title: e.title,
          stage: stageName(project?.stages ?? [], e.stageId),
        }));
      }
    } catch (error) {
      logger.warn("ruling 67 similar-task disclosure failed", {
        projectSlug,
        taskKey,
        error: toError(error),
      });
    }
  }

  // Ruling 244 (F40-55 (c)): the other open PRs this task's merge would likely
  // put in conflict, for the accept dialog.
  let mergeCollisions: PrOverlap[] = [];
  try {
    mergeCollisions = taskMergeCollisions(db, projectSlug, detail);
  } catch (error) {
    logger.warn("ruling 244 merge-collision disclosure failed", {
      projectSlug,
      taskKey,
      error: toError(error),
    });
  }

  // Ruling 103: the completion packet, with each reviewer's verdict on the
  // work under review and the change's size, built from what the caller has
  // already read (the task file, the project's rules, the reviewers' and the
  // deployed agents' names). A screenshot that has left the store is counted,
  // not drawn, checked by name rather than against the attachment list, which
  // stops at the newest 100. An accepted task keeps it as its result, in the
  // archive too.
  const accepted = detail.stage === detail.stages[detail.stages.length - 1]?.id;
  const completion =
    taskFile && (!archived || accepted)
      ? completionView(taskFile.parsed.frontmatter, {
          canSee: (name) => taskAttachmentExists(projectSlug, taskKey, name),
          nameOf: (profileId) => {
            const engaged = detail.reviewers.find((r) => r.profileId === profileId);
            return (
              engaged?.profileName ??
              input.deployedSpecialists.find((s) => s.id === profileId)?.name ??
              engaged?.role ??
              profileId
            );
          },
          ruleReviewers: standing.requiredReviewers.map((r) => r.profileId),
          // Ruling 82: what the work under review rests on.
          sources: sourcesRestedOn(input.keptSources, taskFile.parsed.frontmatter),
        })
      : null;

  // Ruling 83: what the task took, as the card prints it: its facts and what
  // they miss. It rides the card (no completion view, no figure), and is sent
  // only then, so no other payload grows (ruling 11).
  const tookShipped: TookShipped = {};
  if (completion && taskFile) {
    try {
      const took = whatItTook({
        taskKey,
        rows: input.runRows,
        file: taskFile.parsed,
        stages: detail.stages,
        terminalStageId: detail.stages[detail.stages.length - 1]?.id ?? null,
      });
      tookShipped.whatItTook = { facts: took.facts, notes: took.notes };
    } catch (error) {
      logger.warn("ruling 83 what-it-took read failed", {
        projectSlug,
        taskKey,
        error: toError(error),
      });
    }
  }

  return {
    packetAlsoAnswers,
    packetCreateTaskEchoes,
    // R15-1: the accept confirm names exactly what merges.
    workRevisionSha: activeWorkRevision(fm?.workRevision)?.headSha ?? null,
    // R17-2: a verified no-change completion accepts to Done without a merge,
    // and the confirm says so instead of implying delivered work.
    noChanges: fm?.noChanges === true,
    // Ruling 316: a task delivered as files says so in the confirm, rather than
    // a merge it never had. Sent only when it applies (ruling 11).
    filesDelivery:
      fm && deliveredAsFiles(fm) && fm.deliveredAt ? { filesDeliveredAt: fm.deliveredAt } : {},
    defaultBranch: project?.defaultBranch || "main",
    mergeCollisions,
    completion,
    tookShipped,
  };
}

/**
 * Ruling 137: WHOSE accounts this task's agent runs would use, and what those
 * accounts can run. The page used to ship one deployment-wide "is this backend
 * configured" boolean; a run bills the task OWNER, so the honest answer is the
 * owner's own health, and the panels render copy that names them
 * (`app/features/task-detail/run-principal-view.ts`).
 *
 * `null` = nobody to bill: no owner, or a seat pointing at an account that is
 * disabled or gone. Never a secret and never a box: `available` plus the
 * store's own actionable sentence, which the page shows only to the owner.
 * Ruling 304: the queue's decision dialog reads it for the same composer.
 */
export function taskRunPrincipal(
  db: DatabaseSync,
  ownerUserId: string | null,
): TaskRunPrincipalView | null {
  if (!ownerUserId) return null;
  const owner = findUserById(db, ownerUserId);
  // A seat pointing at a deleted or disabled account is not an owner a run can
  // bill, so it reads as unowned here — the same answer `resolveTaskRunPrincipal`
  // gives the run service.
  if (!owner || owner.disabled) return null;
  const health = (backend: "claude" | "codex") => {
    const h = userBackendHealth(db, ownerUserId, backend);
    return { available: h.available, detail: h.detail };
  };
  return {
    ownerUserId,
    ownerName: owner.name,
    claude: health("claude"),
    codex: health("codex"),
  };
}

/**
 * Ruling 304: the Review queue's decision dialog, one task's open decision as
 * its owner answers it without leaving the queue. The fields are the task
 * page's own, read the same way (`taskDecisionReads`), so the dialog draws the
 * page's decision card, completion packet and acceptance ceremony from them.
 */
export interface TaskDecision {
  /** Who is answering: the dialog states each option's tier for them, as the
   *  task page does from the layout's role (`taskPermissions`). An org admin
   *  outside the project reads as admin, the audited override (D2). */
  viewer: { userId: string; role: ProjectRole | null };
  /** The task, with no timeline: the decision does not show one. */
  task: TaskDetail;
  /** R14-3: the archive disposition, which lives in the task file. */
  archived: boolean;
  /** Pending operator recommendations: an acceptance card decides where the
   *  completion packet stands (ruling 316), and an archive withdraws them. */
  recommendations: Recommendation[];
  /** P14-LV-06: the viewer's acceptance authority and the exact refusal. */
  acceptance: AcceptanceAffordance;
  /** U39-32: base commits the branch lacked at the reconciler's last compare. */
  baseBehindBy: number | null;
  /** GitHub web host for the completion packet's links. */
  githubHost: string;
  packetAlsoAnswers: string | null;
  packetCreateTaskEchoes: Record<number, SimilarTaskEcho[]>;
  workRevisionSha: string | null;
  noChanges: boolean;
  filesDeliveredAt?: string;
  defaultBranch: string;
  mergeCollisions: PrOverlap[];
  completion: CompletionView | null;
  whatItTook?: TookCard;
  /** Asking the operator from the dialog writes in the task page's own
   *  composer: its @-mention directory, and whose accounts a mentioned agent's
   *  run would bill (ruling 137). */
  mentionables: Mentionables;
  runPrincipal: TaskRunPrincipalView | null;
}

/** Ruling 304: the dialog's read, or null for a task the project lacks. The
 *  caller has already passed the project's member gate. */
export function readTaskDecision(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; viewerUserId: string; orgAdmin: boolean },
): TaskDecision | null {
  const { projectSlug, taskKey, viewerUserId } = input;
  // No timeline: the dialog shows the decision, and the page keeps the record.
  const detail = getTaskDetail(db, projectSlug, taskKey, { timelineLimit: 0 });
  if (!detail) return null;
  // The workspace layout's `myRole`, read the same way (routes/project.tsx).
  const memberRole =
    listProjectMembers(db, projectSlug).find((m) => m.userId === viewerUserId)?.role ?? null;
  const taskFile = readTaskFile({ projectSlug, taskKey });
  const archived = taskFile?.parsed.frontmatter.archived === true;
  const standing = acceptanceStanding({ projectSlug, taskKey, viewerUserId });
  const reads = taskDecisionReads(db, {
    projectSlug,
    taskKey,
    detail,
    taskFile,
    project: getProject(db, projectSlug),
    archived,
    standing,
    keptSources: readTaskSources(projectSlug, taskKey),
    deployedSpecialists: listDeployedSpecialists(projectSlug),
    runRows: listRunsForTaskRows(db, projectSlug, taskKey),
  });
  return {
    viewer: {
      userId: viewerUserId,
      role: memberRole ?? (input.orgAdmin ? "admin" : null),
    },
    task: detail,
    archived,
    recommendations: taskFile?.parsed.frontmatter.recommendations ?? [],
    acceptance: standing.affordance,
    baseBehindBy: createReconcileBehindByLookup(db)(detail.filePath),
    githubHost: githubWebHost(),
    packetAlsoAnswers: reads.packetAlsoAnswers,
    packetCreateTaskEchoes: reads.packetCreateTaskEchoes,
    workRevisionSha: reads.workRevisionSha,
    noChanges: reads.noChanges,
    ...reads.filesDelivery,
    defaultBranch: reads.defaultBranch,
    mergeCollisions: reads.mergeCollisions,
    completion: reads.completion,
    ...reads.tookShipped,
    mentionables: getMentionables(db, projectSlug),
    runPrincipal: taskRunPrincipal(db, taskFile?.parsed.frontmatter.ownerUserId ?? null),
  };
}
