import type { DatabaseSync } from "node:sqlite";
import { AppError } from "~/server/errors/app-error.server";
import { resolveTaskFilePath, readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  type CreateNotificationInput,
  createNotification,
  markTaskPacketApprovalRead,
} from "~/server/projections/notifications.server";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import type {
  FileActorRef,
  ParsedTaskFile,
  Recommendation,
  TaskFileEvent,
} from "~/schemas/task-file.schema";
import { logger } from "~/server/logging/logger.server";
import type { ActorRender } from "~/shared/mapping/actor.server";
import type { NotificationKind } from "~/shared/mapping/notification.server";
import type { ProjectRole } from "~/shared/rbac";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";

/**
 * The task-mutation SUBSTRATE: the context shape every governed write threads,
 * and the three infrastructure helpers that write-paths call around their own
 * logic (resolve a file ref, re-project after a write, notify the watchers).
 *
 * WHY ITS OWN MODULE — this is a load-bearing cycle break, not tidying.
 * `agent-toolkit.server.ts` needs exactly these three helpers, and importing
 * them from `task-actions.server.ts` closed a real import cycle:
 *
 *     specialist-run → agent-toolkit → task-actions ⇢ (dynamic) specialist-run
 *
 * The `⇢` edge is a deliberate `await import()` that exists ONLY to hide that
 * cycle from the static graph, and hiding it is what made it dangerous: when
 * `resolvePacket`'s `retry_other_backend` arm dynamically imported
 * `specialist-run` while that module was itself still initializing, the import
 * resolved to a HALF-EVALUATED namespace and `startAgentRun` threw
 * `ReferenceError: Cannot access '__vite_ssr_import_30__' before initialization`
 * at its first use of a not-yet-assigned import binding. The retry then failed
 * inside a `catch` that only logged — a human resolved the packet, the packet
 * cleared, and NO agent run started.
 *
 * These three helpers depend only on leaf modules (files/, projections/,
 * errors/, logging/), so hosting them here severs the cycle at its root rather
 * than deferring it. `task-actions.server.ts` re-exports all of them, so the
 * many existing importers are unaffected; modules that would otherwise close
 * the cycle (`agent-toolkit`) import from HERE.
 */

export interface TaskActor {
  userId: string;
  /** Human-readable audit label, e.g. the email. */
  label: string;
}

export interface TaskMutationContext {
  /** Override the data root (tests). Defaults to env VIBERR_DATA_ROOT. */
  dataRoot?: string;
  /** In-process operator authority; routes must never set this. */
  operatorAuthorized?: boolean;
  /** Operator-run state needed to continue the bounded reply/react loop. */
  operatorRun?: {
    backend: RealBackend;
    autonomy: "supervised" | "full";
    reactDepth: number;
    /** Consecutive operator-authored transition chain depth (see
     *  OPERATOR_TRANSITION_CHAIN_CAP). Optional: only the operator drive sets
     *  it; absent reads as 0. */
    transitionDepth?: number;
  };
}

export interface ProjectContext {
  slug: string;
  stages: { id: string; name: string }[];
  workflow: {
    from: string;
    to: string;
    boundary: "auto" | "approval" | "human";
  }[];
  memberRoles: Map<string, ProjectRole>;
  /** Archived projects are read-only (owner ruling R6-3): every governed
   *  mutation is refused until the project is restored. */
  archived: boolean;
}

export function loadProjectContext(
  ctx: TaskMutationContext,
  projectSlug: string,
): ProjectContext {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!file) throw AppError.notFound(`Project ${projectSlug} not found.`);
  const fm = file.parsed.frontmatter;
  return {
    slug: fm.slug,
    stages: fm.stages.map((s) => ({ id: s.id, name: s.name })),
    workflow: fm.workflow.map((w) => ({
      from: w.from,
      to: w.to,
      boundary: w.boundary,
    })),
    memberRoles: new Map(fm.members.map((m) => [m.userId, m.role])),
    archived: fm.archived === true,
  };
}

export function taskRef(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
) {
  return {
    projectSlug,
    taskKey,
    dataRoot: ctx.dataRoot,
  };
}

/** file write already happened — reproject the task file incrementally. */
export function reprojectTask(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  rebuildPath(db, resolveTaskFilePath(taskRef(ctx, projectSlug, taskKey)), {
    dataRoot: ctx.dataRoot,
  });
}

export const OPERATOR_NOTIFY_FROM: ActorRender = { kind: "agent", name: "Operator" };

export interface TaskWatcherNotice {
  projectSlug: string;
  taskKey: string;
  kind: NotificationKind;
  ptype?: "input" | "blocked" | null;
  title?: string | null;
  text: string;
  from?: ActorRender | null;
  occurredAt?: string;
  /** Skip this user (e.g. the human who triggered the event). */
  exceptUserId?: string;
  /** Skip these users — e.g. recipients an earlier notification about the SAME
   *  event already reached (T13's per-recipient dedupe: the packet row and the
   *  quality fallback must never both land in one person's queue, but a watcher
   *  whose prefs dropped the packet row still needs the fallback). */
  exceptUserIds?: readonly string[];
}

/** Notify the owner and project supervisors, respecting routing preferences. */
export function notifyTaskWatchers(
  db: DatabaseSync,
  notice: TaskWatcherNotice,
  ctx: TaskMutationContext = {},
): string[] {
  let recipients: Set<string>;
  try {
    const project = loadProjectContext(ctx, notice.projectSlug);
    recipients = new Set<string>();
    for (const [userId, role] of project.memberRoles) {
      if (role === "admin" || role === "maintainer") recipients.add(userId);
    }
    const owner = readTaskFile(
      taskRef(ctx, notice.projectSlug, notice.taskKey),
    )?.parsed.frontmatter.ownerUserId;
    if (owner) recipients.add(owner);
  } catch (error) {
    // A corrupt project/task file (or context load failure) must NOT silently
    // notify nobody of a real event — log it so the blind spot is diagnosable
    // instead of an undiagnosable "no one got the alert".
    //
    // C10.1: this is a DELIBERATE fail-open, not an oversight. The mutation
    // that produced `notice` has already committed by the time this runs, so
    // throwing here would surface a confusing secondary error for an
    // unrelated write and still leave the mutation applied — worse than a
    // silently-empty recipient set. There is no human-facing surface at this
    // layer to report the failure per-notice (the caller only sees the
    // returned array, and most callers don't inspect its length), so this log
    // line naming the project/task/kind and the real error is, today, the
    // ONLY diagnostic trail for "watchers got nothing". If that ever proves
    // insufficient, the fix belongs in the caller (surface `notified.length
    // === 0` against the notice's expected recipients), not here.
    logger.error("notifyTaskWatchers: recipient resolution failed", {
      projectSlug: notice.projectSlug,
      taskKey: notice.taskKey,
      kind: notice.kind,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return [];
  }
  if (notice.exceptUserId) recipients.delete(notice.exceptUserId);
  for (const userId of notice.exceptUserIds ?? []) recipients.delete(userId);

  const notified: string[] = [];
  for (const userId of recipients) {
    // createNotification consults this recipient's routing prefs and returns
    // null when they've silenced this category — only count real deliveries.
    const notification: CreateNotificationInput = {
      userId,
      kind: notice.kind,
      ptype: notice.ptype ?? null,
      title: notice.title ?? null,
      text: notice.text,
      from: notice.from ?? OPERATOR_NOTIFY_FROM,
      projectSlug: notice.projectSlug,
      taskKey: notice.taskKey,
    };
    // No caller timestamp ⇒ leave the key off and let the writer stamp `now`.
    if (notice.occurredAt) notification.occurredAt = notice.occurredAt;
    const id = createNotification(db, notification);
    if (id) notified.push(userId);
  }
  return notified;
}

// ------------------------------------------- acceptance offers (ruling 137)

/** Why an acceptance offer was withdrawn — the three events that invalidate
 *  it (pass 34, F34-15). */
export type OfferWithdrawalCause =
  | { kind: "revision"; headSha: string }
  | { kind: "packet"; title: string }
  | { kind: "stage_move"; toStageId: string; toStageName: string };

export interface OfferWithdrawal {
  removed: Recommendation[];
  /** Cards left standing after the withdrawal (a `run_agent` card survives). */
  surviving: number;
  /** The timeline note that was written, when anything was removed. */
  note: TaskFileEvent | null;
}

/**
 * Ruling 137: the terminal stage id of a project, read from its file, for the
 * writers that withdraw acceptance offers without a loaded project context
 * (the packet writers, the delivery reconcile). Resolved from the workflow
 * graph like every other role lookup. Null when the project file is
 * unreadable: the withdrawal then removes `accept_completion` cards alone.
 */
export function terminalStageIdFor(ctx: TaskMutationContext, projectSlug: string): string | null {
  const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  if (!project) return null;
  const fm = project.parsed.frontmatter;
  return resolveStageRoles(fm.stages, fm.workflow).terminalId;
}

/** A locked mutator's withdrawal result, carried out of the closure — a plain
 *  `let` is narrowed to `null` past the callback that assigns it. */
export interface OfferWithdrawalSlot {
  offers: OfferWithdrawal | null;
}

function withdrawalCauseText(cause: OfferWithdrawalCause): string {
  switch (cause.kind) {
    case "revision":
      return `a new revision \`${cause.headSha.slice(0, 7)}\` was delivered, so the offer no longer describes the work under review`;
    case "packet":
      return `a decision packet opened ("${cause.title}"), so the task is waiting on a human decision first`;
    case "stage_move":
      return `the task moved to **${cause.toStageName}**, away from the acceptance boundary`;
  }
}

/**
 * Ruling 137 (pass 34, F34-15): remove the acceptance offers a task carries
 * that no longer hold, INSIDE the task file's own lock (the caller is a
 * `updateTaskFile` mutator). `accept_completion` cards go on every cause; a
 * `transition` card targeting the terminal stage is an acceptance too (F19-3)
 * and goes on the packet and stage causes. `run_agent` and `delivery` cards
 * survive all three: more work is compatible with rework.
 *
 * A withdrawal is never silent: one `note` titled "Recommendation withdrawn"
 * names each card and the cause. The audit row and the bell live in
 * {@link recordRecommendationWithdrawal}, which needs the database and runs
 * after the lock. Lives HERE (the leaf) so the delivery reconcile, the packet
 * writers and the stage move can all call it without closing the
 * `specialist-run → agent-toolkit → task-actions` cycle this module exists to
 * break.
 */
export function withdrawAcceptanceOffers(
  parsed: ParsedTaskFile,
  terminalStageId: string | null,
  cause: OfferWithdrawalCause,
  actor: FileActorRef,
): OfferWithdrawal {
  const stale = (r: Recommendation): boolean => {
    if (r.kind === "accept_completion") return true;
    if (cause.kind === "revision") return false;
    return (
      r.kind === "transition" &&
      terminalStageId !== null &&
      r.toStageId === terminalStageId
    );
  };
  const removed = parsed.frontmatter.recommendations.filter(stale);
  if (removed.length === 0) {
    return { removed: [], surviving: parsed.frontmatter.recommendations.length, note: null };
  }
  parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(
    (r) => !stale(r),
  );
  const surviving = parsed.frontmatter.recommendations.length;
  const names = removed.map((r) => `"${r.label}"`).join(", ");
  const note: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "note",
    actor,
    title: "Recommendation withdrawn",
    text:
      `Withdrew ${removed.length === 1 ? "the offer" : "the offers"} ${names}: ${withdrawalCauseText(cause)}.` +
      (surviving > 0
        ? ` ${surviving === 1 ? "1 recommendation still stands" : `${surviving} recommendations still stand`}.`
        : "") +
      " The operator re-recommends acceptance on its next turn if the offer still holds.",
    toAgent: false,
    evidence: null,
  };
  parsed.timeline.unshift(note);
  return { removed, surviving, note };
}

/**
 * The half of a withdrawal that needs the database: one
 * `task.recommendation.withdrawn` audit row per withdrawal event, and the
 * "Waiting on you" bell — `markTaskPacketApprovalRead` marks EVERY unread
 * approval row for the task read, project-wide, and `addRecommendation` raised
 * such a row for a surviving `run_agent` card, so it is called ONLY when no
 * recommendation survives. Call after the locked write that ran
 * {@link withdrawAcceptanceOffers}, and only when it removed something.
 */
export function recordRecommendationWithdrawal(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    withdrawal: OfferWithdrawal;
    cause: OfferWithdrawalCause;
    actor: AuditActor;
  },
): void {
  if (input.withdrawal.removed.length === 0) return;
  recordAudit(db, {
    action: "task.recommendation.withdrawn",
    actor: input.actor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      cause: input.cause.kind,
      removed: input.withdrawal.removed.map((r) => ({
        id: r.id,
        kind: r.kind,
        forHeadSha: r.forHeadSha ?? null,
      })),
      surviving: input.withdrawal.surviving,
    },
  });
  if (input.withdrawal.surviving === 0) {
    markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey, ["approval"]);
  }
}
