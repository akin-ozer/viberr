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
  type OpenScopeViolationInput,
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

/**
 * F39-5 (pass 39): the scopes a project does NOT require, where a refusal is
 * worth saying and is not a violation.
 *
 * Ruling 360 settled the substance for `checks:read` and `credentialAdvisories`
 * says so in as many words — *"Not a missing REQUIRED scope — merging never
 * needed it"* — but the TIMELINE writer never learned it. Live in pass 39, one
 * minute apart, viberr told its owner both of these about the same fact: the
 * task record said **"Policy violation: active PAT is missing `checks:read`"**
 * under a red shield, and the credential card said **"All required scopes
 * proven."** Both true by their own definitions, and the pair is a lie.
 *
 * ONE list, read by the timeline writer and by the credential card, so they
 * cannot drift again.
 */
export const ADVISORY_SCOPES: ReadonlySet<string> = new Set(["checks:read"]);

/** Is a refusal on `scope` an advisory rather than a violation? */
export function scopeIsAdvisory(scope: string): boolean {
  return ADVISORY_SCOPES.has(scope);
}

/**
 * The sentence for a refusal on a scope the project REQUIRES — a genuine
 * violation, under the shield. `scopeFlagText` picks between this and the
 * advisory wording; call that instead of choosing here.
 */
export function policyViolationText(scope: string, consequence: string): string {
  return `**Policy violation:** active PAT is missing \`${scope}\`. ${consequence}`;
}

/** The sentence for a refusal on a scope nothing requires: the same fact and
 *  the same consequence, without calling it a violation. */
export function credentialAdvisoryText(scope: string, consequence: string): string {
  return `**Credential advisory:** the active PAT has no \`${scope}\`, which this project does not require. ${consequence}`;
}

/** The right sentence for `scope`, whichever kind it is. */
export function scopeFlagText(scope: string, consequence: string): string {
  return scopeIsAdvisory(scope)
    ? credentialAdvisoryText(scope, consequence)
    : policyViolationText(scope, consequence);
}

export function policyUpdateText(scope: string): string {
  // The consequence names the ACTUAL scope — no hardcoded pull_request:write
  // copy shown for unrelated scopes (e.g. a `repo` read refusal).
  //
  // F39-5: an advisory scope's clearing note must not say "violation" either,
  // or the resolution contradicts the flag that opened it.
  const opened = scopeIsAdvisory(scope) ? "advisory" : "violation";
  return (
    `**${scopeIsAdvisory(scope) ? "Credential" : "Policy"} update:** \`${scope}\` granted on the project credential. ` +
    `The earlier ${opened} is resolved, and operations needing \`${scope}\` will work now.`
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
  input: {
    projectSlug: string;
    taskKey: string;
    text: string;
    /** F39-5: a scope nothing requires writes a neutral note, not a shield. */
    advisory?: boolean;
  },
  ctx: ScopeFlagContext,
): Promise<boolean> {
  const ref = taskRef({ ...input, ...ctx });
  if (!readTaskFile(ref)) return false; // soft ref — task file may be gone
  await appendTimelineEvent(ref, {
    occurredAt: new Date().toISOString(),
    // F39-5: the `policy` type renders as "Policy violation" under a red
    // shield (`event-meta.ts`), which is the right chip for a scope the
    // project requires and the wrong one for a scope nothing requires. The
    // neutral `note` type already exists for governance notes; an advisory
    // takes it, so the permanent record does not call a non-violation one.
    type: input.advisory ? "note" : "policy",
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
  const open: OpenScopeViolationInput = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    scope: input.scope,
    detail: input.detail,
  };
  // Optional key — with no actor named, the violations API records its own
  // system actor.
  if (input.actor) open.actor = input.actor;
  const { violation, created } = openScopeViolation(db, open);
  if (!created) return { violation, created };

  if (input.taskKey) {
    await appendPolicyEvent(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        text: input.detail,
        advisory: scopeIsAdvisory(input.scope),
      },
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
        advisory: scopeIsAdvisory(violation.scope),
      },
      ctx,
    );
  }
  return result;
}
