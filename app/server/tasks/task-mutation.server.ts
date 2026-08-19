import type { DatabaseSync } from "node:sqlite";
import { AppError } from "~/server/errors/app-error.server";
import { resolveTaskFilePath, readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  type CreateNotificationInput,
  createNotification,
} from "~/server/projections/notifications.server";
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
    logger.error("notifyTaskWatchers: recipient resolution failed", {
      projectSlug: notice.projectSlug,
      taskKey: notice.taskKey,
      kind: notice.kind,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return [];
  }
  if (notice.exceptUserId) recipients.delete(notice.exceptUserId);

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
