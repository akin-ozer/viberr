import type { DatabaseSync } from "node:sqlite";
import {
  recordAudit,
  type AuditActor,
  type AuditEventInput,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import { emitProjectionEvent } from "~/server/events/projection-events.server";
import { newId } from "~/shared/ids/new-id.server";
import { scopeIsAdvisory } from "~/shared/credential-scopes";

/**
 * Scope-violation records (Phase 7 — replaces the phase-4 policy-event
 * derivation, ruling 221).
 *
 * One row per violation with its own open/resolved lifecycle; the row
 * carries the task the policy engine flagged (`taskKey`, soft ref). The
 * rail Settings badge is the open count per project. A partial unique
 * index (`idx_scope_violations__open_unique`) guarantees at most one OPEN
 * row per (project, scope, task) — opening is idempotent.
 *
 * This module is the DB-side API only (rows + audit + projection event).
 * Writing the typed `policy` timeline event into the flagged task's
 * task.md is the caller's job (github-reconciler / pat-validator grant
 * flow) so file writes stay in the github/secrets layer.
 *
 * No violation is seeded: the squashed baseline (db/migrations/0001_baseline.sql)
 * carries no scope_violations rows, so a fresh database starts with an empty
 * rail badge; violations are opened at runtime by the callers above.
 */

export type ScopeViolationStatus = "open" | "resolved";

export interface ScopeViolationRecord {
  id: string;
  projectSlug: string;
  taskKey: string | null;
  scope: string;
  detail: string;
  status: ScopeViolationStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

type ScopeViolationRow = {
  id: string;
  project_slug: string;
  task_key: string | null;
  scope: string;
  detail: string;
  status: ScopeViolationStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
};

function mapRow(row: ScopeViolationRow): ScopeViolationRecord {
  return {
    id: row.id,
    projectSlug: row.project_slug,
    taskKey: row.task_key,
    scope: row.scope,
    detail: row.detail,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

/**
 * Open policy-violation count for the rail Settings badge (shell §4.1).
 * SIGNATURE IS A CONTRACT — app/routes/project.tsx (shell loader) calls it;
 * do not change without updating that call site.
 */
export function countOpenPolicyViolations(
  db: DatabaseSync,
  projectSlug: string,
): number {
  // Ruling 221(b) (F39-13): an ADVISORY scope is not a violation. `checks:read`
  // is required by nothing and its record is still kept; the timeline event,
  // the credential card and this badge read the same list. The row stays
  // `open` either way, so this count used to render it in
  // `.count.violations` — bold `--danger` on the Settings row — and on the live
  // ax-clone board every one of the four it counted was `checks:read`. A red
  // number pointing at a page where nothing can be done about it.
  // SAFETY: the SELECT names exactly one column, `scope`, which 0001_baseline
  // declares TEXT NOT NULL — so every row yields exactly this shape.
  const rows = db
    .prepare(
      `SELECT scope FROM scope_violations
       WHERE project_slug = ? AND status = 'open'`,
    )
    .all(projectSlug) as { scope: string }[];
  return rows.filter((r) => !scopeIsAdvisory(r.scope)).length;
}

/** Newest-first listing; optionally filtered by status. */
export function listScopeViolations(
  db: DatabaseSync,
  projectSlug: string,
  options: { status?: ScopeViolationStatus } = {},
): ScopeViolationRecord[] {
  // SAFETY: ScopeViolationRow mirrors the nine `scope_violations` columns
  // 0001_baseline declares, so `SELECT *` yields exactly it — including the
  // CHECK that restricts `status` to the two ScopeViolationStatus values.
  const rows = (
    options.status
      ? db
          .prepare(
            `SELECT * FROM scope_violations
             WHERE project_slug = ? AND status = ?
             ORDER BY created_at DESC, id DESC`,
          )
          .all(projectSlug, options.status)
      : db
          .prepare(
            `SELECT * FROM scope_violations
             WHERE project_slug = ?
             ORDER BY created_at DESC, id DESC`,
          )
          .all(projectSlug)
  ) as ScopeViolationRow[];
  return rows.map(mapRow);
}

function getScopeViolation(
  db: DatabaseSync,
  id: string,
): ScopeViolationRecord | null {
  // SAFETY: same `SELECT *` / column-list correspondence as listScopeViolations.
  const row = db
    .prepare(`SELECT * FROM scope_violations WHERE id = ?`)
    .get(id) as ScopeViolationRow | undefined;
  return row ? mapRow(row) : null;
}

/** The open violation for (project, scope, task), if any. */
export function findOpenScopeViolation(
  db: DatabaseSync,
  projectSlug: string,
  scope: string,
  taskKey: string | null,
): ScopeViolationRecord | null {
  // SAFETY: same `SELECT *` / column-list correspondence as listScopeViolations.
  const row = db
    .prepare(
      `SELECT * FROM scope_violations
       WHERE project_slug = ? AND scope = ? AND status = 'open'
         AND coalesce(task_key, '') = coalesce(?, '')`,
    )
    .get(projectSlug, scope, taskKey) as ScopeViolationRow | undefined;
  return row ? mapRow(row) : null;
}

export interface OpenScopeViolationInput {
  projectSlug: string;
  /** Task the violation is flagged on (ruling 221: rows carry their task). */
  taskKey?: string | null;
  scope: string;
  /** Secret-free, human-readable description (RichText micro-format ok). */
  detail?: string;
  actor?: AuditActor;
}

/** What `openScopeViolation` reports back: the row that now holds the
 * violation, and whether this call is what opened it. */
export interface OpenScopeViolationOutcome {
  violation: ScopeViolationRecord;
  created: boolean;
}

/**
 * Opens a violation. Idempotent: an existing OPEN row for the same
 * (project, scope, task) is returned with `created: false` and nothing is
 * written — retries never duplicate rows, audit events or SSE.
 */
export function openScopeViolation(
  db: DatabaseSync,
  input: OpenScopeViolationInput,
): OpenScopeViolationOutcome {
  const taskKey = input.taskKey ?? null;
  const existing = findOpenScopeViolation(
    db,
    input.projectSlug,
    input.scope,
    taskKey,
  );
  if (existing) return { violation: existing, created: false };

  const now = new Date().toISOString();
  const record: ScopeViolationRecord = {
    id: newId("sv"),
    projectSlug: input.projectSlug,
    taskKey,
    scope: input.scope,
    detail: input.detail ?? "",
    status: "open",
    createdAt: now,
    resolvedAt: null,
    resolvedBy: null,
  };
  db.prepare(
    `INSERT INTO scope_violations
       (id, project_slug, task_key, scope, detail, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  ).run(
    record.id,
    record.projectSlug,
    record.taskKey,
    record.scope,
    record.detail,
    record.createdAt,
  );
  const opened: AuditEventInput = {
    action: "github.scope_violation.opened",
    actor: input.actor ?? SYSTEM_ACTOR,
    subjectKind: "scope_violation",
    subjectId: record.id,
    projectSlug: record.projectSlug,
    details: { scope: record.scope },
  };
  // A project-wide violation carries no task ref at all — the audit row must not
  // claim one (ruling 221: rows carry their task, and only when they have one).
  if (record.taskKey) opened.taskKey = record.taskKey;
  recordAudit(db, opened);
  emitProjectionEvent({
    type: "violation.updated",
    projectSlug: record.projectSlug,
    taskKey: record.taskKey,
    occurredAt: now,
  });
  return { violation: record, created: true };
}

/**
 * Resolves a violation by id. Idempotent: already-resolved rows return
 * `resolved: false` with the stored record; unknown ids return null.
 */
export function resolveScopeViolation(
  db: DatabaseSync,
  id: string,
  actor: AuditActor = SYSTEM_ACTOR,
): { violation: ScopeViolationRecord; resolved: boolean } | null {
  const current = getScopeViolation(db, id);
  if (!current) return null;
  if (current.status === "resolved") {
    return { violation: current, resolved: false };
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE scope_violations
     SET status = 'resolved', resolved_at = ?, resolved_by = ?
     WHERE id = ? AND status = 'open'`,
  ).run(now, actor.userId ?? actor.label, id);
  const violation: ScopeViolationRecord = {
    ...current,
    status: "resolved",
    resolvedAt: now,
    resolvedBy: actor.userId ?? actor.label,
  };
  const resolvedAudit: AuditEventInput = {
    action: "github.scope_violation.resolved",
    actor,
    subjectKind: "scope_violation",
    subjectId: id,
    projectSlug: violation.projectSlug,
    details: { scope: violation.scope },
  };
  if (violation.taskKey) resolvedAudit.taskKey = violation.taskKey;
  recordAudit(db, resolvedAudit);
  emitProjectionEvent({
    type: "violation.updated",
    projectSlug: violation.projectSlug,
    taskKey: violation.taskKey,
    occurredAt: now,
  });
  return { violation, resolved: true };
}
