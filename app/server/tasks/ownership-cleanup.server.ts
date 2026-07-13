import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ParsedProjectFile } from "~/schemas/project-file.schema";
import type { UserRole } from "~/shared/mapping/user.server";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import {
  projectDir,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { roleCan } from "~/shared/rbac";
import { newId } from "~/shared/ids/new-id.server";

export const OWNERSHIP_CLEANUP_MARKER = "_viberrOwnershipCleanup" as const;

export interface OwnershipCleanupActor extends AuditActor {
  userId: string;
  orgRole?: UserRole;
}

export type OwnershipCleanupReason =
  "member_removed" | "role_demoted" | "org_user_removed";

export interface OwnershipCleanupBatch {
  id: string;
  projectSlug: string;
  targetUserId: string;
  reason: OwnershipCleanupReason;
  taskKeys: readonly string[];
}

export interface OwnershipCleanupContext {
  dataRoot?: string;
  /** Deterministic staging seam. A throw leaves project membership/role and
   * every task untouched; marker-less rows are cancelled by retry/boot. */
  beforeTaskReleaseForTests?: (input: {
    taskKey: string;
    releasedTaskKeys: readonly string[];
  }) => void | Promise<void>;
  /** Fault seam after one canonical owner release but before projection/audit. */
  afterTaskCanonicalReleaseForTests?: (input: {
    taskKey: string;
  }) => void | Promise<void>;
}

interface OwnershipCleanupIntentRow {
  id: string;
  batch_id: string;
  project_slug: string;
  task_key: string;
  task_incarnation: string;
  target_user_id: string;
  target_name: string;
  reason: OwnershipCleanupReason;
  actor_user_id: string;
  actor_label: string;
  actor_name_hint: string;
  authority_source: "org_admin_override" | null;
  created_at: string;
}

function readCleanupIntents(
  db: Database.Database,
  input?: {
    projectSlug?: string;
    targetUserId?: string;
    batchId?: string;
  },
): OwnershipCleanupIntentRow[] {
  const clauses: string[] = [];
  const values: string[] = [];
  if (input?.projectSlug) {
    clauses.push("project_slug = ?");
    values.push(input.projectSlug);
  }
  if (input?.targetUserId) {
    clauses.push("target_user_id = ?");
    values.push(input.targetUserId);
  }
  if (input?.batchId) {
    clauses.push("batch_id = ?");
    values.push(input.batchId);
  }
  return db
    .prepare(
      `SELECT * FROM ownership_cleanup_intents
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at, id`,
    )
    .all(...values) as OwnershipCleanupIntentRow[];
}

function markerMap(parsed: ParsedProjectFile): Record<string, string> {
  const value = parsed.unknownFrontmatter[OWNERSHIP_CLEANUP_MARKER];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Write the exact cleanup batch proof in the same project.md write that
 * removes/demotes access. Recovery may release owner seats only when this
 * marker and the resulting access state both still agree. */
export function markProjectOwnershipCleanupCommitted(
  parsed: ParsedProjectFile,
  batch: OwnershipCleanupBatch | null,
): void {
  if (!batch) return;
  parsed.unknownFrontmatter[OWNERSHIP_CLEANUP_MARKER] = {
    ...markerMap(parsed),
    [batch.targetUserId]: batch.id,
  };
}

function canonicalAccessChangeCommitted(
  intent: OwnershipCleanupIntentRow,
  dataRoot?: string,
): boolean {
  const project = readProjectFile({
    projectSlug: intent.project_slug,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  });
  if (!project) return false;
  if (markerMap(project.parsed)[intent.target_user_id] !== intent.batch_id) {
    return false;
  }
  const member = project.parsed.frontmatter.members.find(
    (candidate) => candidate.userId === intent.target_user_id,
  );
  return intent.reason === "role_demoted"
    ? !member || !roleCan(member.role, "own-task")
    : !member;
}

function stageCleanupIntent(
  db: Database.Database,
  input: {
    batchId: string;
    projectSlug: string;
    taskKey: string;
    taskIncarnation: string;
    targetUserId: string;
    targetName: string;
    reason: OwnershipCleanupReason;
    actor: OwnershipCleanupActor;
    actorNameHint: string;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO ownership_cleanup_intents
       (id, batch_id, project_slug, task_key, task_incarnation,
        target_user_id, target_name, reason, actor_user_id, actor_label,
        actor_name_hint, authority_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("owncln"),
    input.batchId,
    input.projectSlug,
    input.taskKey,
    input.taskIncarnation,
    input.targetUserId,
    input.targetName,
    input.reason,
    input.actor.userId,
    input.actor.label,
    input.actorNameHint,
    input.actor.auditAuthoritySource === "org_admin_override"
      ? "org_admin_override"
      : null,
    new Date().toISOString(),
  );
}

function cancelCleanupIntent(
  db: Database.Database,
  intent: OwnershipCleanupIntentRow,
): void {
  db.prepare(`DELETE FROM ownership_cleanup_intents WHERE id = ?`).run(
    intent.id,
  );
}

async function convergeCleanupIntent(
  db: Database.Database,
  intent: OwnershipCleanupIntentRow,
  ctx: OwnershipCleanupContext,
): Promise<boolean> {
  const ref = {
    projectSlug: intent.project_slug,
    taskKey: intent.task_key,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  };
  const current = readTaskFile(ref);
  if (
    !current ||
    current.parsed.frontmatter.createdAt !== intent.task_incarnation
  ) {
    cancelCleanupIntent(db, intent);
    return false;
  }
  const canonicalEventExists = current.parsed.timeline.some(
    (event) => event.sourceIntentId === intent.id,
  );
  if (!canonicalEventExists) {
    if (
      !canonicalAccessChangeCommitted(intent, ctx.dataRoot) ||
      current.parsed.frontmatter.ownerUserId !== intent.target_user_id
    ) {
      // A marker-less row never crossed the final role/member commit. A task
      // with a different current owner is also no longer ours to mutate.
      cancelCleanupIntent(db, intent);
      return false;
    }
    await updateTaskFile(ref, (parsed) => {
      if (
        parsed.frontmatter.createdAt !== intent.task_incarnation ||
        parsed.frontmatter.ownerUserId !== intent.target_user_id ||
        parsed.timeline.some((event) => event.sourceIntentId === intent.id)
      ) {
        return;
      }
      parsed.frontmatter.ownerUserId = null;
      parsed.timeline.unshift({
        occurredAt: intent.created_at,
        type: "assign",
        actor: {
          kind: "human",
          userId: intent.actor_user_id,
          nameHint: intent.actor_name_hint,
        },
        title: null,
        text: `Released **${intent.target_name}** from task ownership because their project access changed — the acceptance seat is unassigned.`,
        toAgent: false,
        evidence: null,
        sourceIntentId: intent.id,
      });
    });
    await ctx.afterTaskCanonicalReleaseForTests?.({
      taskKey: intent.task_key,
    });
  }

  const committed = readTaskFile(ref);
  if (
    !committed ||
    committed.parsed.frontmatter.createdAt !== intent.task_incarnation ||
    !committed.parsed.timeline.some(
      (event) => event.sourceIntentId === intent.id,
    )
  ) {
    return false;
  }
  rebuildPath(
    db,
    taskFilePath(intent.project_slug, intent.task_key, ctx.dataRoot),
    ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {},
  );
  const details = {
    previousOwnerUserId: intent.target_user_id,
    forced: true,
    reason: intent.reason,
    sourceIntentId: intent.id,
    cleanupBatchId: intent.batch_id,
    taskIncarnation: intent.task_incarnation,
    ...(intent.authority_source
      ? { authoritySource: intent.authority_source }
      : {}),
  };
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, occurred_at, actor_user_id, actor_label, action,
          subject_kind, subject_id, project_slug, task_key, details_json)
       VALUES (?, ?, ?, ?, 'task.ownership.admin_released',
               'task', ?, ?, ?, ?)`,
    ).run(
      `evt:${intent.id}`,
      intent.created_at,
      intent.actor_user_id,
      intent.actor_label,
      intent.task_key,
      intent.project_slug,
      intent.task_key,
      JSON.stringify(details),
    );
    db.prepare(`DELETE FROM ownership_cleanup_intents WHERE id = ?`).run(
      intent.id,
    );
  })();
  return true;
}

/** Stage every exact task incarnation while access is still unchanged. This
 * function never edits task.md. The caller must atomically add the batch marker
 * to the final authorized role/member write, then call convergence. */
export async function stageProjectOwnershipCleanup(
  db: Database.Database,
  input: {
    projectSlug: string;
    targetUserId: string;
    targetName: string;
    reason: OwnershipCleanupReason;
  },
  actor: OwnershipCleanupActor,
  ctx: OwnershipCleanupContext = {},
): Promise<OwnershipCleanupBatch | null> {
  // Finish or cancel leftovers before reserving a new exact operation marker.
  for (const intent of readCleanupIntents(db, {
    projectSlug: input.projectSlug,
    targetUserId: input.targetUserId,
  })) {
    await convergeCleanupIntent(db, intent, {
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
  }

  const tasksRoot = path.join(
    projectDir(input.projectSlug, ctx.dataRoot),
    "tasks",
  );
  if (!existsSync(tasksRoot)) return null;
  const actorName =
    (
      db.prepare(`SELECT name FROM users WHERE id = ?`).get(actor.userId) as
        { name: string } | undefined
    )?.name ?? actor.label;
  const batchId = newId("ownbatch");
  const taskKeys: string[] = [];
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskKey = entry.name;
    const file = readTaskFile({
      projectSlug: input.projectSlug,
      taskKey,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    if (file?.parsed.frontmatter.ownerUserId !== input.targetUserId) continue;
    const taskIncarnation = file.parsed.frontmatter.createdAt;
    if (!taskIncarnation) {
      throw new Error(
        `Cannot stage ${taskKey} ownership cleanup without a canonical task incarnation.`,
      );
    }
    await ctx.beforeTaskReleaseForTests?.({
      taskKey,
      releasedTaskKeys: taskKeys,
    });
    stageCleanupIntent(db, {
      batchId,
      projectSlug: input.projectSlug,
      taskKey,
      taskIncarnation,
      targetUserId: input.targetUserId,
      targetName: input.targetName,
      reason: input.reason,
      actor,
      actorNameHint: actorName,
    });
    taskKeys.push(taskKey);
  }
  return taskKeys.length > 0
    ? {
        id: batchId,
        projectSlug: input.projectSlug,
        targetUserId: input.targetUserId,
        reason: input.reason,
        taskKeys,
      }
    : null;
}

export async function convergeProjectOwnershipCleanup(
  db: Database.Database,
  batch: OwnershipCleanupBatch | null,
  ctx: OwnershipCleanupContext = {},
): Promise<string[]> {
  if (!batch) return [];
  const released: string[] = [];
  for (const intent of readCleanupIntents(db, { batchId: batch.id })) {
    if (await convergeCleanupIntent(db, intent, ctx)) {
      released.push(intent.task_key);
    }
  }
  return [...new Set(released)];
}

/** Boot convergence is authorized only by the exact batch marker committed in
 * project.md. Thus a crash before the role/member write cancels cleanly, while
 * a crash after it completes every owner release and audit exactly once. */
export async function recoverOwnershipCleanupIntents(
  db: Database.Database,
  ctx: Pick<OwnershipCleanupContext, "dataRoot"> = {},
): Promise<{ completed: number; cancelled: number; errors: number }> {
  let completed = 0;
  let cancelled = 0;
  let errors = 0;
  for (const intent of readCleanupIntents(db)) {
    try {
      if (await convergeCleanupIntent(db, intent, ctx)) completed += 1;
      else cancelled += 1;
    } catch {
      errors += 1;
    }
  }
  return { completed, cancelled, errors };
}

/** Request retry convergence scoped to one exact project binding. This uses
 * the same canonical marker proof as boot and is safe before deciding whether
 * a role/member request is already in its target state. */
export async function recoverOwnershipCleanupIntentsForTarget(
  db: Database.Database,
  input: { projectSlug: string; targetUserId: string },
  ctx: Pick<OwnershipCleanupContext, "dataRoot"> = {},
): Promise<{ completed: number; cancelled: number; errors: number }> {
  let completed = 0;
  let cancelled = 0;
  let errors = 0;
  for (const intent of readCleanupIntents(db, input)) {
    try {
      if (await convergeCleanupIntent(db, intent, ctx)) completed += 1;
      else cancelled += 1;
    } catch {
      errors += 1;
    }
  }
  return { completed, cancelled, errors };
}
