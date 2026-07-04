import type Database from "better-sqlite3";
import {
  type AuditActor,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  readTaskFile,
  resolveTaskFilePath,
} from "~/server/files/task-writer.server";
import { createNotification } from "~/server/projections/notifications.server";
import {
  openScopeViolation,
  resolveScopeViolation,
  type ScopeViolationRecord,
} from "~/server/projections/policy-violations.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";

/**
 * Policy-engine side effects around scope violations (ruling 5 + github
 * view spec §5.2/§5.4). The violations API owns the rows; this module owns
 * the FILE side effects that must accompany open/resolve:
 *
 * flag    → open row (idempotent) + typed `policy` violation event written
 *           into the flagged task's task.md + notification to the task
 *           owner + reprojection. Retries are safe: an already-open row
 *           writes nothing twice.
 * resolve → resolve row + typed `policy` update event on the violation's
 *           own task + reprojection. Also idempotent.
 *
 * The seeded VIB-142 violation (migration 0005) already has its policy
 * event and notification from the phase-3 seed — flagging it again is a
 * no-op because the row is already open.
 */

export const POLICY_ENGINE_ACTOR = {
  kind: "system" as const,
  systemId: "policy-engine",
};

export function policyViolationText(scope: string, consequence: string): string {
  return `**Policy violation:** active PAT is missing \`${scope}\`. ${consequence}`;
}

export function policyUpdateText(scope: string): string {
  return (
    `**Policy update:** \`${scope}\` granted on the project credential. ` +
    `The earlier violation is resolved — PR auto-sync will work after merge.`
  );
}

export interface ScopeFlagContext {
  dataRoot?: string;
}

function taskRef(input: {
  projectSlug: string;
  taskKey: string;
  dataRoot?: string;
}) {
  return {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  };
}

async function appendPolicyEvent(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; text: string },
  ctx: ScopeFlagContext,
): Promise<boolean> {
  const ref = taskRef({ ...input, ...ctx });
  if (!readTaskFile(ref)) return false; // soft ref — task file may be gone
  await appendTimelineEvent(ref, {
    occurredAt: new Date().toISOString(),
    type: "policy",
    actor: POLICY_ENGINE_ACTOR,
    title: null,
    text: input.text,
    toAgent: false,
    evidence: null,
  });
  rebuildPath(db, resolveTaskFilePath(ref), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  return true;
}

function taskOwnerUserId(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): string | null {
  const row = db
    .prepare(
      `SELECT owner_user_id FROM task_projections
       WHERE project_slug = ? AND task_key = ?`,
    )
    .get(projectSlug, taskKey) as { owner_user_id: string | null } | undefined;
  return row?.owner_user_id ?? null;
}

export interface FlagScopeViolationInput {
  projectSlug: string;
  /** Task the failure happened on (violation rows carry their task). */
  taskKey: string | null;
  scope: string;
  /** Event/notification body, e.g. from policyViolationText(). */
  detail: string;
  actor?: AuditActor;
}

/**
 * Opens a violation with full policy-engine side effects. Returns the row
 * plus whether anything new happened (created=false → no event, no
 * notification, no reprojection — fully idempotent).
 */
export async function flagScopeViolation(
  db: Database.Database,
  input: FlagScopeViolationInput,
  ctx: ScopeFlagContext = {},
): Promise<{ violation: ScopeViolationRecord; created: boolean }> {
  const { violation, created } = openScopeViolation(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    scope: input.scope,
    detail: input.detail,
    ...(input.actor ? { actor: input.actor } : {}),
  });
  if (!created) return { violation, created };

  if (input.taskKey) {
    await appendPolicyEvent(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, text: input.detail },
      ctx,
    );
    const ownerUserId = taskOwnerUserId(db, input.projectSlug, input.taskKey);
    if (ownerUserId) {
      createNotification(db, {
        userId: ownerUserId,
        kind: "policy",
        text: input.detail,
        from: { kind: "system", name: "Policy engine" },
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
      });
    }
  }
  return { violation, created };
}

/**
 * Resolves a violation with the typed `policy` update event on its own
 * task. Idempotent (already-resolved → no event).
 */
export async function resolveScopeViolationWithEvent(
  db: Database.Database,
  violationId: string,
  actor: AuditActor = SYSTEM_ACTOR,
  ctx: ScopeFlagContext = {},
): Promise<{ violation: ScopeViolationRecord; resolved: boolean } | null> {
  const result = resolveScopeViolation(db, violationId, actor);
  if (!result || !result.resolved) return result;
  const { violation } = result;
  if (violation.taskKey) {
    await appendPolicyEvent(
      db,
      {
        projectSlug: violation.projectSlug,
        taskKey: violation.taskKey,
        text: policyUpdateText(violation.scope),
      },
      ctx,
    );
  }
  return result;
}
