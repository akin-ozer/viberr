import type Database from "better-sqlite3";
import {
  type AuditActor,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import {
  getScopeViolation,
  openScopeViolation,
  resolveScopeViolation,
  type ScopeViolationRecord,
} from "~/server/projections/policy-violations.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { notifyTaskWatchers } from "~/server/tasks/task-actions.server";

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
  // The consequence names the ACTUAL scope — no hardcoded pull_request:write
  // copy shown for unrelated scopes (e.g. a `repo` read refusal).
  return (
    `**Policy update:** \`${scope}\` granted on the project credential. ` +
    `The earlier violation is resolved — operations needing \`${scope}\` will work now.`
  );
}

export interface ScopeFlagContext {
  dataRoot?: string;
  /** Optional exact lifecycle observed before an asynchronous scope probe.
   * A recreated task with the same key must not receive the old violation's
   * policy event. `null` deliberately means the task was absent at capture. */
  expectedTaskCreatedAt?: string | null;
  signal?: AbortSignal;
}

function assertScopeLifecycleActive(
  ctx: ScopeFlagContext,
  currentCreatedAt: string | null,
): void {
  if (ctx.signal?.aborted) {
    throw new DOMException("Project lifecycle ownership was revoked.", "AbortError");
  }
  if (
    ctx.expectedTaskCreatedAt !== undefined &&
    currentCreatedAt !== ctx.expectedTaskCreatedAt
  ) {
    throw new DOMException("Task lifecycle ownership changed.", "AbortError");
  }
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
  const current = readTaskFile(ref);
  if (!current) {
    assertScopeLifecycleActive(ctx, null);
    return false; // soft ref — task file may be gone
  }
  assertScopeLifecycleActive(ctx, current.parsed.frontmatter.createdAt);
  let appended = false;
  await updateTaskFile(ref, (parsed) => {
    assertScopeLifecycleActive(ctx, parsed.frontmatter.createdAt);
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "policy",
      actor: POLICY_ENGINE_ACTOR,
      title: null,
      text: input.text,
      toAgent: false,
      evidence: null,
    });
    appended = true;
  });
  if (!appended) return false;
  rebuildPath(db, resolveTaskFilePath(ref), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
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
  db: Database.Database,
  input: FlagScopeViolationInput,
  ctx: ScopeFlagContext = {},
): Promise<{ violation: ScopeViolationRecord; created: boolean }> {
  if (input.taskKey) {
    const current = readTaskFile(
      taskRef({
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      }),
    );
    assertScopeLifecycleActive(
      ctx,
      current?.parsed.frontmatter.createdAt ?? null,
    );
  }
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
      ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {},
    );
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
  const pending = getScopeViolation(db, violationId);
  if (pending?.taskKey) {
    const current = readTaskFile(
      taskRef({
        projectSlug: pending.projectSlug,
        taskKey: pending.taskKey,
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      }),
    );
    assertScopeLifecycleActive(
      ctx,
      current?.parsed.frontmatter.createdAt ?? null,
    );
  }
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
