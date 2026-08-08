import type { DatabaseSync } from "node:sqlite";
import {
  createActorRenderOverlay,
  type ActorRender,
} from "~/shared/mapping/actor.server";
import type { TaskEventRow } from "~/shared/mapping/task-event.server";
import { listScopeViolations } from "./policy-violations.server";

/**
 * Activity view read models (activity.md, Phase 9C).
 *
 * Stream: ONE projection query over `task_events` — every typed timeline
 * event across the project's tasks, `ORDER BY occurred_at DESC, id DESC`
 * (the total order the porting notes mandate). `title` is folded into the
 * text as a leading bold sentence (`**{title}.** {text}`), exactly the
 * mock's `norm()`.
 *
 * Audit logs: the REAL `scope_violations` + `audit_events` tables merged
 * into the mock's four display kinds (violation / blockedact / change /
 * audit). Violations carry their own per-row open/resolved state
 * (ruling 5) plus resolve context (who/when — Phase 10). audit_events rows
 * are mapped through an explicit whitelist covering every project-scoped
 * governance action family, each with a readable text template (the
 * fallback template guarantees no raw JSON ever reaches the UI) —
 * stream-visible activity (comments, transitions, github events) stays in
 * the Stream panel, auth/org-scoped rows have no project home. Both panels
 * are capped with loader-driven "show older" pagination (Phase 10).
 */

export interface ActivityStreamRow {
  id: number;
  taskKey: string;
  /** One of the 9 contract event types, or unknown (renderer tolerates). */
  type: string;
  actor: ActorRender | null;
  occurredAt: string;
  /** RichText micro-format, title already folded in. */
  text: string;
}

export const ACTIVITY_STREAM_LIMIT = 200;

/** Total stream rows for the project (drives the "show older" button). */
export function countActivityStream(
  db: DatabaseSync,
  slug: string,
): number {
  return (
    db
      .prepare(`SELECT count(*) AS c FROM task_events WHERE project_slug = ?`)
      .get(slug) as { c: number }
  ).c;
}

export function listActivityStream(
  db: DatabaseSync,
  slug: string,
  options: { limit?: number } = {},
): ActivityStreamRow[] {
  const rows = db
    .prepare(
      `SELECT id, task_key, type, actor_json, occurred_at, title, text
       FROM task_events WHERE project_slug = ?
       ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    )
    .all(slug, options.limit ?? ACTIVITY_STREAM_LIMIT) as Pick<
    TaskEventRow,
    "id" | "task_key" | "type" | "actor_json" | "occurred_at" | "title" | "text"
  >[];
  // E1: overlay the current users-table identity on baked human actors so a
  // rename shows immediately (deleted users keep the stored snapshot).
  const overlay = createActorRenderOverlay(db);
  return rows.map((row) => ({
    id: row.id,
    taskKey: row.task_key,
    type: row.type,
    actor: row.actor_json
      ? overlay(JSON.parse(row.actor_json) as ActorRender)
      : null,
    occurredAt: row.occurred_at,
    text: row.title ? `**${row.title}.** ${row.text}` : row.text,
  }));
}

// ---------------------------------------------------------------- audit log

export type AuditLogKind = "violation" | "blockedact" | "change" | "audit";

export interface AuditLogEntry {
  id: string;
  kind: AuditLogKind;
  /** RichText micro-format; rows with a task chip end in "on" so the chip
   * completes the sentence (mock convention). */
  text: string;
  taskKey: string | null;
  occurredAt: string;
  /** Violations only — drives the open/resolved pill. */
  status: "open" | "resolved" | null;
  /** Violations only — resolve context for the resolved pill (Phase 10). */
  resolvedAt: string | null;
  /** Resolver display name (user id resolved; label fallback). */
  resolvedBy: string | null;
}

export const AUDIT_LOG_LIMIT = 60;

/** audit_events actions surfaced in the panel, mapped to display kinds.
 * A deliberate whitelist of the project-scoped GOVERNANCE families —
 * stream-visible activity (comments, transitions, github/completion
 * events) renders in the Stream panel instead. Every listed action has a
 * readable template in `auditText`; the default template covers additions
 * that land here before a bespoke sentence does. */
const AUDIT_ACTION_KINDS: Record<string, AuditLogKind> = {
  "project.policy.boundary_changed": "change",
  "project.member.role_changed": "change",
  "project.member.invited": "change",
  "project.member.removed": "change",
  "project.stage.added": "change",
  "project.stage.renamed": "change",
  "project.stage.removed": "change",
  "project.stage.reordered": "change",
  "project.settings.updated": "change",
  "project.agent_profile.created": "change",
  "project.agent_profile.updated": "change",
  "project.agent_profile.deleted": "change",
  // P13-D-7: the fourth member of the agent-profile family — deploying an org
  // library profile into the project is the same class of config change as
  // creating one here, and was the only sibling missing.
  "project.agent_profile.deployed": "change",
  "project.created": "change",
  "project.archived": "change",
  "project.unarchived": "change",
  "project.deleted": "change",
  "github.reconcile.project": "audit",
  "github.credential.assigned": "change",
  "github.credential.cleared": "change",
  "github.credential.revalidated": "change",
  "github.pr.merge_refused": "blockedact",
  "task.ownership.admin_released": "audit",
    "task.operator.autonomy_clamped": "audit",
  "runtime.run.started": "audit",
  "runtime.run.interrupted": "audit",
  // P13-D-7: the two governance overrides that were RECORDED but surfaced
  // nowhere — reconstructing "who bypassed the required reviewer" used to need
  // raw SQLite access, the exact thing this panel exists to make unnecessary.
  "task.acceptance.forced": "audit",
  "project.org_admin.override": "audit",
  // P13-D-8: NFR10's fourth category — the refused attempt itself.
  "project.authority.denied": "blockedact",
};

const BOUNDARY_LABEL: Record<string, string> = {
  auto: "auto-advance",
  approval: "human approval",
  human: "human only",
};

interface AuditRow {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_label: string;
  action: string;
  subject_id: string | null;
  task_key: string | null;
  details_json: string | null;
  actor_name: string | null;
}

function auditText(
  row: AuditRow,
  resolveUserName: (userId: string | null | undefined) => string | null,
): string {
  const actor = row.actor_name ?? row.actor_label;
  const d = (
    row.details_json ? JSON.parse(row.details_json) : {}
  ) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  switch (row.action) {
    case "project.policy.boundary_changed": {
      const from = str(d.from) ?? "?";
      const to = str(d.to) ?? "?";
      const boundary = BOUNDARY_LABEL[str(d.boundary) ?? ""] ?? str(d.boundary) ?? "?";
      return `${actor} set **${from} → ${to}** to ${boundary}.`;
    }
    case "project.member.role_changed": {
      const target =
        resolveUserName(str(d.targetUserId)) ?? "a member";
      return `${actor} set ${target} to **${str(d.to) ?? "?"}**.`;
    }
    case "project.member.invited":
      return `${actor} invited ${str(d.email) ?? "a member"} as ${str(d.role) ?? "viewer"}.`;
    case "project.member.removed": {
      const target = resolveUserName(row.subject_id) ?? "a member";
      return `${actor} removed ${target} from the project.`;
    }
    case "project.stage.added": {
      const name = str(d.name);
      return name
        ? `${actor} added workflow stage **${name}**.`
        : `${actor} added a workflow stage.`;
    }
    case "project.stage.renamed": {
      const name = str(d.name);
      return name
        ? `${actor} renamed a workflow stage to **${name}**.`
        : `${actor} renamed a workflow stage.`;
    }
    case "project.stage.removed":
      return `${actor} removed a workflow stage.`;
    case "project.stage.reordered":
      return `${actor} reordered the workflow stages.`;
    case "project.settings.updated":
      return `${actor} updated project settings.`;
    case "project.agent_profile.created":
      return `${actor} created agent profile **${str(d.name) ?? "?"}**.`;
    case "project.agent_profile.updated":
      return `${actor} updated agent profile **${str(d.name) ?? "?"}**.`;
    case "project.agent_profile.deleted":
      return `${actor} deleted agent profile **${str(d.name) ?? "?"}**.`;
    case "project.agent_profile.deployed":
      return `${actor} deployed agent profile **${str(d.name) ?? "?"}** to the project.`;
    case "project.created":
      return `${actor} created the project.`;
    case "project.archived":
      return `${actor} archived the project.`;
    case "project.unarchived":
      return `${actor} restored the project from the archive.`;
    case "project.deleted":
      return `${actor} deleted the project.`;
    case "github.reconcile.project":
      return `${actor} reconciled the project against GitHub — recorded per audit policy on`;
    case "github.credential.assigned":
      return `${actor} assigned the project GitHub credential.`;
    case "github.credential.cleared":
      return `${actor} cleared the project GitHub credential.`;
    case "github.credential.revalidated": {
      // The grant-scope / re-check attempt with its typed outcome (Phase 10).
      const outcome = str(d.outcome);
      if (outcome === "no_pat_configured") {
        return `${actor} requested a scope grant — no GitHub credential configured.`;
      }
      if (outcome === "network_unavailable") {
        return `${actor} re-checked the project credential — GitHub was unreachable.`;
      }
      const resolved =
        typeof d.resolvedViolations === "number" ? d.resolvedViolations : 0;
      return resolved > 0
        ? `${actor} re-validated the project credential — ${resolved} policy flag${resolved === 1 ? "" : "s"} resolved.`
        : `${actor} re-checked the project credential scopes.`;
    }
    case "github.pr.merge_refused":
      return `Blocked: review PR merge refused — the project credential is missing \`${str(d.scope) ?? "a scope"}\` — on`;
    case "task.ownership.admin_released":
      return `${actor} released the task owner — recorded per audit policy on`;
    case "runtime.run.started": {
      const role = str(d.role) ?? "agent";
      return `${actor} opened the ${role} runtime session — recorded per audit policy on`;
    }
    case "runtime.run.interrupted":
      return `${actor} interrupted an agent run — recorded per audit policy on`;
    // P13-D-7: the admin override that bypasses the review gate. `bypassed`
    // names the gate that was in force (or "no gate (already acceptable)").
    case "task.acceptance.forced": {
      const bypassed = str(d.bypassed);
      return bypassed && !bypassed.startsWith("no gate")
        ? `${actor} force-accepted the completion, bypassing ${bypassed} — on`
        : `${actor} force-accepted the completion — on`;
    }
    // P13-D-7: the D2 emergency override — an org admin acting above (or
    // without) their project membership. `what` is the guard's own copy.
    case "project.org_admin.override": {
      const what = str(d.what) ?? "act on this project";
      const memberRole = str(d.memberRole);
      return `${actor} used the org-admin override to ${what} (project role: ${memberRole ?? "not a member"}).`;
    }
    // P13-D-8: a refused attempt. Reads as a blocked action, like the merge
    // refusal above.
    case "project.authority.denied": {
      const what = str(d.what) ?? "act on this project";
      const memberRole = str(d.memberRole);
      return `Blocked: ${actor} tried to ${what} — ${
        memberRole
          ? `their project role (${memberRole}) is not permitted`
          : "not a project member"
      }.`;
    }
    default:
      // Whitelisted-but-untemplated (future additions): honest fallback.
      return `${actor} — ${row.action.replace(/[._]/g, " ")}.`;
  }
}

/** Rows ending in "on" expect the task chip; drop the dangler when the
 * audit row carries no task ref. */
function finishText(text: string, taskKey: string | null): string {
  if (taskKey || !text.endsWith(" on")) return text;
  return text.slice(0, -3) + ".";
}

/** Total audit-panel rows for the project (drives "show older"). */
export function countAuditLog(db: DatabaseSync, slug: string): number {
  const violations = (
    db
      .prepare(
        `SELECT count(*) AS c FROM scope_violations WHERE project_slug = ?`,
      )
      .get(slug) as { c: number }
  ).c;
  const actions = Object.keys(AUDIT_ACTION_KINDS);
  const placeholders = actions.map(() => "?").join(", ");
  const audits = (
    db
      .prepare(
        `SELECT count(*) AS c FROM audit_events
         WHERE project_slug = ? AND action IN (${placeholders})`,
      )
      .get(slug, ...actions) as { c: number }
  ).c;
  return violations + audits;
}

export function listAuditLog(
  db: DatabaseSync,
  slug: string,
  options: { limit?: number } = {},
): AuditLogEntry[] {
  const limit = options.limit ?? AUDIT_LOG_LIMIT;

  const nameStmt = db.prepare(`SELECT name FROM users WHERE id = ?`);
  const nameCache = new Map<string, string | null>();
  const resolveUserName = (userId: string | null | undefined): string | null => {
    if (!userId) return null;
    if (!nameCache.has(userId)) {
      const hit = nameStmt.get(userId) as { name: string } | undefined;
      nameCache.set(userId, hit?.name ?? null);
    }
    return nameCache.get(userId) ?? null;
  };

  const violations: AuditLogEntry[] = listScopeViolations(db, slug).map(
    (v) => ({
      id: v.id,
      kind: "violation",
      text: v.taskKey
        ? `Project credential is missing \`${v.scope}\` — flagged by the policy engine on`
        : `Project credential is missing \`${v.scope}\` — flagged by the policy engine.`,
      taskKey: v.taskKey,
      occurredAt: v.createdAt,
      status: v.status,
      resolvedAt: v.resolvedAt,
      // resolved_by stores a user id when known, else the actor label.
      resolvedBy: v.resolvedBy
        ? (resolveUserName(v.resolvedBy) ?? v.resolvedBy)
        : null,
    }),
  );

  const actions = Object.keys(AUDIT_ACTION_KINDS);
  const placeholders = actions.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT a.id, a.occurred_at, a.actor_user_id, a.actor_label, a.action,
              a.subject_id, a.task_key, a.details_json, u.name AS actor_name
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.project_slug = ? AND a.action IN (${placeholders})
       ORDER BY a.occurred_at DESC, a.id DESC LIMIT ?`,
    )
    .all(slug, ...actions, limit) as unknown as AuditRow[];

  const auditEntries: AuditLogEntry[] = rows.map((row) => ({
    id: row.id,
    kind: AUDIT_ACTION_KINDS[row.action] ?? "change",
    text: finishText(auditText(row, resolveUserName), row.task_key),
    taskKey: row.task_key,
    occurredAt: row.occurred_at,
    status: null,
    resolvedAt: null,
    resolvedBy: null,
  }));

  return [...violations, ...auditEntries]
    .sort((a, b) =>
      a.occurredAt === b.occurredAt
        ? b.id.localeCompare(a.id)
        : b.occurredAt.localeCompare(a.occurredAt),
    )
    .slice(0, limit);
}
