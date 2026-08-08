import type { DatabaseSync } from "node:sqlite";
import {
  type AuditActor,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  readTaskFile,
  resolveTaskFilePath,
} from "~/server/files/task-writer.server";
import {
  openScopeViolation,
  resolveScopeViolation,
  type ScopeViolationRecord,
} from "~/server/projections/policy-violations.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { notifyTaskWatchers } from "~/server/tasks/task-mutation.server";

/**
 * Policy-engine side effects around scope violations (ruling 5 + github
 * view spec §5.2/§5.4). The violations API owns the rows; this module owns
 * the FILE side effects that must accompany open/resolve:
 *
 * flag    → open row (idempotent) + typed `policy` violation event written
 *           into the flagged task's task.md + `policy` notification fanned
 *           out to the task's watchers (owner + project admins/maintainers,
 *           prefs honored — E3: the old owner-only path notified NOBODY on
 *           an ownerless task) + reprojection. Retries are safe: an
 *           already-open row writes nothing twice.
 * resolve → resolve row + typed `policy` update event on the violation's
 *           own task + reprojection. Also idempotent.
 *
 * The product seed ships zero demo data — the violations table starts
 * empty (migrations are squashed to db/migrations/0001_baseline.sql, schema
 * only). Only the e2e fixture seeds a VIB-142 violation with its policy event
 * and notification (test-support/demo-seed.ts); there, flagging it again is a
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
  // The consequence names the ACTUAL scope — no hardcoded pull_request:write
  // copy shown for unrelated scopes (e.g. a `repo` read refusal).
  return (
    `**Policy update:** \`${scope}\` granted on the project credential. ` +
    `The earlier violation is resolved — operations needing \`${scope}\` will work now.`
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
    dataRoot: input.dataRoot,
  };
}

async function appendPolicyEvent(
  db: DatabaseSync,
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
    dataRoot: ctx.dataRoot,
  });
  return true;
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
  db: DatabaseSync,
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
    // E3: fan out to the humans who supervise the task — owner (if any) plus
    // project admins/maintainers, deduped, routing prefs honored. The old
    // owner-only createNotification meant an ownerless task alerted nobody.
    notifyTaskWatchers(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        kind: "policy",
        text: input.detail,
        from: { kind: "system", name: "Policy engine" },
      },
      { dataRoot: ctx.dataRoot },
    );
  }
  return { violation, created };
}

/**
 * Resolves a violation with the typed `policy` update event on its own
 * task. Idempotent (already-resolved → no event).
 */
export async function resolveScopeViolationWithEvent(
  db: DatabaseSync,
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
