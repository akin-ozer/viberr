import type { DatabaseSync } from "node:sqlite";
import {
  agentBackendName,
  agentRoleDisplay,
  decodeActorRef,
  slugToRole,
  systemIdToName,
} from "~/server/files/actor-ref.server";
import { z } from "zod";
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

/* ------------------------------------------------------- feed filters (P21)
 * Owner request 2026-08-20: both panels get their own search + filters. The
 * stream filters compile to SQL (the table can be large); the audit panel's
 * free-text search matches the RENDERED sentences instead (see listAuditLog),
 * because the reader searches what they see, not `details_json` internals. */

export interface StreamFilters {
  /** Substring over the event text, title and task key (case-insensitive). */
  q?: string;
  /** Exact `actor_ref` — the stable identity behind a display name: a user
   *  id, `agent/<profileId>` (backend-agnostic, D32-14), a system id, or the
   *  bare `operator` / `controller`. */
  actorRef?: string;
  /** Exact event type (one of the timeline vocabulary, tolerated unknown). */
  type?: string;
  /** Task key, case-insensitive exact match. */
  task?: string;
  /** Inclusive ISO day (YYYY-MM-DD) lower bound on occurred_at. */
  from?: string;
  /** Inclusive ISO day (YYYY-MM-DD) upper bound on occurred_at. */
  to?: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** LIKE-escape so a user typing `%` or `_` searches those characters. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The exclusive upper bound for an inclusive ISO day: the following day. */
function dayAfter(day: string): string {
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** WHERE clause + args shared by the stream list and its count, so "X of Y"
 *  can never disagree with the rows it stands over. */
function streamWhere(slug: string, f: StreamFilters) {
  const parts = ["project_slug = ?"];
  const args: string[] = [slug];
  const q = f.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    parts.push(
      "(text LIKE ? ESCAPE '\\' OR COALESCE(title, '') LIKE ? ESCAPE '\\' OR task_key LIKE ? ESCAPE '\\')",
    );
    args.push(like, like, like);
  }
  if (f.actorRef?.trim()) {
    parts.push("actor_ref = ?");
    args.push(f.actorRef.trim());
  }
  if (f.type?.trim()) {
    parts.push("type = ?");
    args.push(f.type.trim());
  }
  if (f.task?.trim()) {
    parts.push("task_key = ? COLLATE NOCASE");
    args.push(f.task.trim());
  }
  if (f.from && ISO_DAY.test(f.from)) {
    parts.push("occurred_at >= ?");
    args.push(f.from);
  }
  if (f.to && ISO_DAY.test(f.to)) {
    parts.push("occurred_at < ?");
    args.push(dayAfter(f.to));
  }
  return { sql: parts.join(" AND "), args };
}

/** The stream's filter vocabulary: every actor that ever wrote an event (by
 *  stable ref, labelled with the current display name) and every event type
 *  present. Options, not free text — a filter you can only mistype is noise. */
export function streamFilterOptions(db: DatabaseSync, slug: string) {
  // SAFETY: `actor_ref` is NOT NULL; GROUP BY yields one representative
  // `actor_json` per ref, and that column's single writer stringifies an
  // ActorRender (rebuilder.server.ts).
  const actorRows = db
    .prepare(
      `SELECT actor_ref AS ref, actor_json FROM task_events
       WHERE project_slug = ? GROUP BY actor_ref`,
    )
    .all(slug) as Array<{ ref: string; actor_json: string }>;
  const overlay = createActorRenderOverlay(db);
  const actors = actorRows
    .map((row) => ({
      ref: row.ref,
      // SAFETY: same single-writer ActorRender invariant as listActivityStream.
      label: overlay(JSON.parse(row.actor_json) as ActorRender).name,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  // SAFETY: `type` is a NOT NULL text column.
  const typeRows = db
    .prepare(
      `SELECT DISTINCT type FROM task_events WHERE project_slug = ? ORDER BY type`,
    )
    .all(slug) as Array<{ type: string }>;
  return { actors, types: typeRows.map((row) => row.type) };
}

/** Total stream rows matching the filters (drives "X of Y" + "show older"). */
export function countActivityStream(
  db: DatabaseSync,
  slug: string,
  filters: StreamFilters = {},
): number {
  const where = streamWhere(slug, filters);
  // SAFETY: a bare `count(*)` aggregate always yields exactly one row — zero on
  // an empty match, never no row — and `c` is the integer SQLite counted.
  return (
    db
      .prepare(`SELECT count(*) AS c FROM task_events WHERE ${where.sql}`)
      .get(...where.args) as { c: number }
  ).c;
}

export function listActivityStream(
  db: DatabaseSync,
  slug: string,
  options: { limit?: number; filters?: StreamFilters } = {},
): ActivityStreamRow[] {
  const where = streamWhere(slug, options.filters ?? {});
  // SAFETY: the SELECT names exactly the seven `task_events` columns the Pick
  // lists, and 0001_baseline declares all of them NOT NULL except `title` —
  // which is why TaskEventRow types that one, and only that one, nullable.
  const rows = db
    .prepare(
      // F28-D1: tie-break on `id ASC`, NOT `id DESC`. Unlike the append-only
      // notifications / audit tables (where a larger id IS newer, so their
      // shared `id DESC` idiom is right), `task_events` is rebuilt wholesale
      // per task with `position 0` (the file's NEWEST) inserted FIRST — so the
      // smallest id is the newest event. The task page orders `position ASC`
      // (newest first); matching that here means smallest-id-first on a
      // same-`occurred_at` tie, i.e. `id ASC`. `id DESC` reversed the two
      // relative to the task page whenever timestamps collided (e.g. the up-to-4
      // events one reconcile pass stamps in a single tick).
      `SELECT id, task_key, type, actor_json, occurred_at, title, text
       FROM task_events WHERE ${where.sql}
       ORDER BY occurred_at DESC, id ASC LIMIT ?`,
    )
    .all(...where.args, options.limit ?? ACTIVITY_STREAM_LIMIT) as Pick<
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
    // SAFETY: `actor_json` has ONE writer — the rebuilder stores
    // `JSON.stringify(resolveActor(event.actor))`, and `resolveActor` returns an
    // ActorRender by construction.
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
const AUDIT_ACTION_KINDS = {
  "project.policy.boundary_changed": "change",
  "project.policy.guardrail_changed": "change",
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
} satisfies Record<string, AuditLogKind>;

/** The whitelist above as the lookup `listAuditLog` reads: `action` arrives as
 * a plain `audit_events` column, so only a keyed get can answer it. */
const AUDIT_KIND_BY_ACTION = new Map(Object.entries(AUDIT_ACTION_KINDS));

const BOUNDARY_LABEL = new Map([
  ["auto", "auto-advance"],
  ["approval", "human approval"],
  ["human", "human only"],
]);

type AuditRow = {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_label: string;
  action: string;
  subject_id: string | null;
  task_key: string | null;
  details_json: string | null;
  actor_name: string | null;
};

/** A `details_json` string the sentences below interpolate. Empty is the same
 * as absent: every template already carries the fallback a reader sees when the
 * writer recorded nothing, and a bold `****` in the audit column reads as a bug
 * rather than as a value. */
const detailText = z.string().min(1).nullable().catch(null);

/**
 * The `details_json` fields this panel renders, decoded at the read boundary.
 *
 * `details` is free-form JSON — each guard writes the keys its own sentence
 * needs — so every field is INDEPENDENTLY tolerant: one junk value degrades to
 * that one sentence's fallback instead of failing the whole audit row (or, with
 * a canonical schema, the whole panel). Unknown keys are dropped; nothing here
 * reads them.
 */
const auditDetailsSchema = z.object({
  from: detailText,
  to: detailText,
  boundary: detailText,
  targetUserId: detailText,
  email: detailText,
  role: detailText,
  name: detailText,
  // F20-13: the composite boundary change a stage removal caused (display
  // NAMES), written only when re-joining the neighbours TIGHTENED a hop.
  tightened: z
    .object({ from: detailText, to: detailText, boundary: detailText })
    .nullable()
    .catch(null),
  outcome: detailText,
  resolvedViolations: z.number().catch(0),
  scope: detailText,
  bypassed: detailText,
  what: detailText,
  memberRole: detailText,
  // E32-6: guardrail changes (Policy → Guardrails card).
  id: detailText,
  label: detailText,
  op: detailText,
  value: z.number().optional().catch(undefined),
});

/** A blob that is not an object at all — never written by `recordAudit`, but
 * the column is free text — reads as "nothing recorded", like an absent one. */
const auditDetails = auditDetailsSchema.catch(() =>
  auditDetailsSchema.parse({}),
);

function auditText(
  row: AuditRow,
  resolveUserName: (userId: string | null | undefined) => string | null,
): string {
  const actor = row.actor_name ?? displayAuditActorLabel(row.actor_label);
  const d = auditDetails.parse(
    row.details_json ? JSON.parse(row.details_json) : {},
  );

  switch (row.action) {
    case "project.policy.boundary_changed": {
      const from = d.from ?? "?";
      const to = d.to ?? "?";
      const boundary =
        BOUNDARY_LABEL.get(d.boundary ?? "") ?? d.boundary ?? "?";
      return `${actor} set **${from} → ${to}** to ${boundary}.`;
    }
    case "project.policy.guardrail_changed": {
      // E32-6: label + op from the details (the row id is the subject).
      const label = d.label ?? d.id ?? row.subject_id;
      if (d.op === "remove") return `${actor} removed the **${label}** guardrail.`;
      if (d.op === "value") return `${actor} set **${label}** to ${d.value ?? "?"}.`;
      return `${actor} turned **${label}** ${d.op === "on" ? "on" : "off"}.`;
    }
    case "project.member.role_changed": {
      const target = resolveUserName(d.targetUserId) ?? "a member";
      return `${actor} set ${target} to **${d.to ?? "?"}**.`;
    }
    case "project.member.invited":
      return `${actor} invited ${d.email ?? "a member"} as ${d.role ?? "viewer"}.`;
    case "project.member.removed": {
      const target = resolveUserName(row.subject_id) ?? "a member";
      return `${actor} removed ${target} from the project.`;
    }
    case "project.stage.added": {
      const name = d.name;
      return name
        ? `${actor} added workflow stage **${name}**.`
        : `${actor} added a workflow stage.`;
    }
    case "project.stage.renamed": {
      const name = d.name;
      return name
        ? `${actor} renamed a workflow stage to **${name}**.`
        : `${actor} renamed a workflow stage.`;
    }
    case "project.stage.removed": {
      // F20-27: the writer records `details: { id, name }`; read the name (it was
      // stored all along and ignored, so every removal printed the bare
      // "removed a workflow stage").
      const name = d.name;
      const base = name
        ? `${actor} removed workflow stage **${name}**`
        : `${actor} removed a workflow stage`;
      // F20-13: removing a stage re-joins its neighbours, and the merged hop
      // keeps the STRICTER of the two boundaries it replaced
      // (transitions.ts → rejoinChainAroundStage). When that tightened a
      // surviving hop, the writer records the composite change under
      // `tightened` so the audit row discloses the side effect the toast alone
      // hid — the same vocabulary a manual boundary flip audits under. A
      // recorded hop with no readable boundary says nothing, so it is dropped.
      const tightened = d.tightened;
      if (tightened) {
        const tf = tightened.from ?? "?";
        const tt = tightened.to ?? "?";
        const tb =
          BOUNDARY_LABEL.get(tightened.boundary ?? "") ?? tightened.boundary;
        if (tb) return `${base}. **${tf} → ${tt}** is now ${tb}.`;
      }
      return `${base}.`;
    }
    case "project.stage.reordered":
      return `${actor} reordered the workflow stages.`;
    case "project.settings.updated":
      return `${actor} updated project settings.`;
    case "project.agent_profile.created":
      return `${actor} created agent profile **${d.name ?? "?"}**.`;
    case "project.agent_profile.updated":
      return `${actor} updated agent profile **${d.name ?? "?"}**.`;
    case "project.agent_profile.deleted":
      return `${actor} deleted agent profile **${d.name ?? "?"}**.`;
    case "project.agent_profile.deployed":
      return `${actor} deployed agent profile **${d.name ?? "?"}** to the project.`;
    case "project.created":
      return `${actor} created the project.`;
    case "project.archived":
      return `${actor} archived the project.`;
    case "project.unarchived":
      return `${actor} restored the project from the archive.`;
    case "project.deleted":
      return `${actor} deleted the project.`;
    case "github.reconcile.project":
      return `${actor} reconciled the project against GitHub. Recorded per audit policy on`;
    case "github.credential.assigned":
      return `${actor} assigned the project GitHub credential.`;
    case "github.credential.cleared":
      return `${actor} cleared the project GitHub credential.`;
    case "github.credential.revalidated": {
      // The grant-scope / re-check attempt with its typed outcome (Phase 10).
      const outcome = d.outcome;
      if (outcome === "no_pat_configured") {
        return `${actor} requested a scope grant, but no GitHub credential is configured.`;
      }
      if (outcome === "network_unavailable") {
        return `${actor} re-checked the project credential, but GitHub was unreachable.`;
      }
      const resolved = d.resolvedViolations;
      return resolved > 0
        ? `${actor} re-validated the project credential and resolved ${resolved} policy flag${resolved === 1 ? "" : "s"}.`
        : `${actor} re-checked the project credential scopes.`;
    }
    case "github.pr.merge_refused":
      return `Blocked: review PR merge refused (the project credential is missing \`${d.scope ?? "a scope"}\`) on`;
    case "task.ownership.admin_released":
      return `${actor} released the task owner. Recorded per audit policy on`;
    case "runtime.run.started": {
      const role = d.role ?? "agent";
      return `${actor} opened the ${role} runtime session. Recorded per audit policy on`;
    }
    case "runtime.run.interrupted":
      return `${actor} interrupted an agent run. Recorded per audit policy on`;
    // P13-D-7: the admin override that bypasses the review gate.
    //
    // `bypassed` is NOT a gate NAME, whatever the old comment here claimed: the
    // writer stores `acceptanceRefusalReason(...)`, i.e. the full refusal
    // SENTENCE the human was shown, remediation clause and all. Interpolating
    // that after "bypassing" produced live nonsense in the audit column —
    // "bypassing VC-8's delivered revision has no approving verdict yet — run a
    // review for a verdict, or an admin can force-accept." Read it as the quoted
    // reason it is, and drop the remediation half: the reader is looking at a
    // record of an override that already happened, so "or an admin can
    // force-accept" is advice for a decision nobody still has to make. The
    // reason/remediation halves are split by a sentence boundary; rows recorded
    // before the copy was de-dashed used an em dash, so both are handled.
    case "task.acceptance.forced": {
      const bypassed = d.bypassed;
      if (!bypassed || bypassed.startsWith("no gate")) {
        return `${actor} force-accepted the completion on`;
      }
      const reason = bypassed
        .split(" — ")[0]!
        .split(/(?<=\.)\s/)[0]!
        .replace(/\.$/, "");
      return `${actor} force-accepted the completion, overriding the acceptance gate (${reason}) on`;
    }
    // P13-D-7: the D2 emergency override — an org admin acting above (or
    // without) their project membership. `what` is the guard's own copy.
    case "project.org_admin.override": {
      const what = d.what ?? "act on this project";
      const memberRole = d.memberRole;
      return `${actor} used the org-admin override to ${what} (project role: ${memberRole ?? "not a member"}).`;
    }
    // P13-D-8: a refused attempt. Reads as a blocked action, like the merge
    // refusal above.
    case "project.authority.denied": {
      const what = d.what ?? "act on this project";
      const memberRole = d.memberRole;
      return `Blocked: ${actor} tried to ${what}, but ${
        memberRole
          ? `their project role (${memberRole}) is not permitted`
          : "they are not a project member"
      }.`;
    }
    default:
      // Whitelisted-but-untemplated (future additions): honest fallback.
      return `${actor}: ${row.action.replace(/[._]/g, " ")}.`;
  }
}

/** Rows ending in "on" expect the task chip; drop the dangler when the
 * audit row carries no task ref. */
function finishText(text: string, taskKey: string | null): string {
  if (taskKey || !text.endsWith(" on")) return text;
  return text.slice(0, -3) + ".";
}

/** Filters for the audit panel (owner request 2026-08-20). `q` matches the
 *  RENDERED sentence — the reader searches what they see — so a searched
 *  collection is bounded by AUDIT_SCAN_CAP rows per leg rather than compiled
 *  to SQL. The other filters compile to SQL / cheap predicates. */
export interface AuditFilters {
  q?: string;
  kind?: AuditLogKind;
  /** Actor display label, exactly as the panel prints it. Violations are
   *  raised by the policy engine, not a person — an actor filter drops them. */
  actor?: string;
  task?: string;
  /** Inclusive ISO days (YYYY-MM-DD), same contract as StreamFilters. */
  from?: string;
  to?: string;
}

/** How many governance rows a rendered-text search will scan per leg. Audit
 *  tables hold project-scoped governance events (not the task stream), so this
 *  is a generous ceiling, stated rather than silent. */
export const AUDIT_SCAN_CAP = 1000;

function auditFiltersActive(f: AuditFilters): boolean {
  return Boolean(
    f.q?.trim() ||
      f.kind ||
      f.actor?.trim() ||
      f.task?.trim() ||
      (f.from && ISO_DAY.test(f.from)) ||
      (f.to && ISO_DAY.test(f.to)),
  );
}

/** The audit panel's actor vocabulary: everyone who ever wrote an audit row,
 *  by current display name (label fallback). */
/** One audit-panel actor filter option: `value` is the stored label the
 *  filter matches on, `label` what a reader sees. */
export interface AuditActorOption {
  value: string;
  label: string;
}

/**
 * E32-8 (pass 32, live): an audit row's `actor_label` is whatever `recordAudit`
 * was handed — a human's email, a system id (`delivery`, `system:workspace-
 * reconcile`) or an agent's ENCODED ref (`agent:claude/developer
 * (Implementation)`). The Stream names every actor; the Audit panel printed the
 * raw token in its filter and in every sentence ("agent:claude/developer
 * (Implementation) set …"). Humans resolve through the users table (below);
 * this turns the other two families into the same display names the timeline
 * uses (`actor-ref.server.ts`), so one actor reads one way on both panels.
 */
export function displayAuditActorLabel(raw: string): string {
  const ref = decodeActorRef(raw);
  switch (ref.kind) {
    case "agent":
      return `${slugToRole(ref.profileId)} (${agentRoleDisplay(ref)}) · ${agentBackendName(ref.backend)}`;
    case "system":
      return systemIdToName(ref.systemId);
    case "operator":
      return "Operator";
    case "controller":
      return "Controller";
    case "human":
      return ref.nameHint ?? raw;
    case "unknown":
      // Bare system words (`delivery`, `system`) and anything else: capitalise.
      return raw ? raw[0]!.toUpperCase() + raw.slice(1) : raw;
  }
}

export function auditFilterActors(db: DatabaseSync, slug: string): AuditActorOption[] {
  // SAFETY: `actor_label` is NOT NULL; `name` is NOT NULL on users, null only
  // when the LEFT JOIN finds no row.
  const rows = db
    .prepare(
      `SELECT DISTINCT a.actor_label AS label, u.name AS name
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.project_slug = ?`,
    )
    .all(slug) as Array<{ label: string; name: string | null }>;
  // The filter compiles to `COALESCE(u.name, a.actor_label) = ?` (below), so a
  // human's VALUE is their current name — one option per person even when
  // callers recorded them under different labels (email on one path, name on
  // another; live the panel listed "Arda" twice) — and everyone else's is the
  // stored label, displayed decoded.
  const byValue = new Map<string, AuditActorOption>();
  for (const row of rows) {
    const value = row.name ?? row.label;
    if (byValue.has(value)) continue;
    byValue.set(value, {
      value,
      label: row.name ?? displayAuditActorLabel(row.label),
    });
  }
  return [...byValue.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Every audit-panel entry matching the filters, newest first, both legs
 *  merged — the single source `listAuditLog` and `countAuditLog` slice and
 *  measure, so the count can never disagree with the rows. */
function collectAuditEntries(
  db: DatabaseSync,
  slug: string,
  filters: AuditFilters,
  cap: number,
): AuditLogEntry[] {
  const nameStmt = db.prepare(`SELECT name FROM users WHERE id = ?`);
  const nameCache = new Map<string, string | null>();
  const resolveUserName = (userId: string | null | undefined): string | null => {
    if (!userId) return null;
    if (!nameCache.has(userId)) {
      // SAFETY: the statement selects the single `name` column, which
      // 0001_baseline declares NOT NULL on `users`; a missing id gives no row.
      const hit = nameStmt.get(userId) as { name: string } | undefined;
      nameCache.set(userId, hit?.name ?? null);
    }
    return nameCache.get(userId) ?? null;
  };

  const q = filters.q?.trim().toLowerCase() ?? "";
  const task = filters.task?.trim().toUpperCase() ?? "";
  const fromDay = filters.from && ISO_DAY.test(filters.from) ? filters.from : "";
  const toBound =
    filters.to && ISO_DAY.test(filters.to) ? dayAfter(filters.to) : "";
  const inDateRange = (iso: string) =>
    (!fromDay || iso >= fromDay) && (!toBound || iso < toBound);

  // Violations leg — small (one row per missing scope), filtered in TS. They
  // are raised by the policy engine, so an actor filter excludes them all.
  const violations: AuditLogEntry[] =
    (filters.kind && filters.kind !== "violation") || filters.actor?.trim()
      ? []
      : listScopeViolations(db, slug)
          .map(
            (v): AuditLogEntry => ({
              id: v.id,
              kind: "violation",
              text: v.taskKey
                ? `Project credential is missing \`${v.scope}\`. Flagged by the policy engine on`
                : `Project credential is missing \`${v.scope}\`. Flagged by the policy engine.`,
              taskKey: v.taskKey,
              occurredAt: v.createdAt,
              status: v.status,
              resolvedAt: v.resolvedAt,
              // resolved_by stores a user id when known, else the actor label.
              resolvedBy: v.resolvedBy
                ? (resolveUserName(v.resolvedBy) ?? v.resolvedBy)
                : null,
            }),
          )
          .filter((entry) => !task || entry.taskKey?.toUpperCase() === task)
          .filter((entry) => inDateRange(entry.occurredAt));

  // Audit-events leg — SQL for everything except the rendered-text search.
  const actions = filters.kind
    ? Object.entries(AUDIT_ACTION_KINDS)
        .filter(([, kind]) => kind === filters.kind)
        .map(([action]) => action)
    : Object.keys(AUDIT_ACTION_KINDS);
  let auditEntries: AuditLogEntry[] = [];
  if (actions.length > 0) {
    const placeholders = actions.map(() => "?").join(", ");
    const parts = [`a.project_slug = ?`, `a.action IN (${placeholders})`];
    const args: string[] = [slug, ...actions];
    if (filters.actor?.trim()) {
      parts.push("COALESCE(u.name, a.actor_label) = ?");
      args.push(filters.actor.trim());
    }
    if (task) {
      parts.push("a.task_key = ? COLLATE NOCASE");
      args.push(task);
    }
    if (fromDay) {
      parts.push("a.occurred_at >= ?");
      args.push(fromDay);
    }
    if (toBound) {
      parts.push("a.occurred_at < ?");
      args.push(toBound);
    }
    // SAFETY: the SELECT names exactly AuditRow's nine members. 0001_baseline
    // declares `id`, `occurred_at`, `actor_label` and `action` NOT NULL on
    // `audit_events`; the rest are nullable there, and `actor_name` is null
    // whenever the LEFT JOIN finds no user — which is how AuditRow types them.
    const rows = db
      .prepare(
        `SELECT a.id, a.occurred_at, a.actor_user_id, a.actor_label, a.action,
                a.subject_id, a.task_key, a.details_json, u.name AS actor_name
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE ${parts.join(" AND ")}
         ORDER BY a.occurred_at DESC, a.id DESC LIMIT ?`,
      )
      .all(...args, cap) as AuditRow[];
    auditEntries = rows.map((row) => ({
      id: row.id,
      kind: AUDIT_KIND_BY_ACTION.get(row.action) ?? "change",
      text: finishText(auditText(row, resolveUserName), row.task_key),
      taskKey: row.task_key,
      occurredAt: row.occurred_at,
      status: null,
      resolvedAt: null,
      resolvedBy: null,
    }));
  }

  const matchesQ = (entry: AuditLogEntry) =>
    !q ||
    entry.text.toLowerCase().includes(q) ||
    (entry.taskKey ?? "").toLowerCase().includes(q);

  return [...violations, ...auditEntries]
    .filter(matchesQ)
    .sort((a, b) =>
      a.occurredAt === b.occurredAt
        ? b.id.localeCompare(a.id)
        : b.occurredAt.localeCompare(a.occurredAt),
    );
}

/** Total audit-panel rows matching the filters (drives "X of Y" and "show
 *  older"). Unfiltered it stays the cheap aggregate; filtered it measures the
 *  same collection the list slices, bounded by AUDIT_SCAN_CAP. */
export function countAuditLog(
  db: DatabaseSync,
  slug: string,
  filters: AuditFilters = {},
): number {
  if (auditFiltersActive(filters)) {
    return collectAuditEntries(db, slug, filters, AUDIT_SCAN_CAP).length;
  }
  // SAFETY: a `count(*)` aggregate yields exactly one row whose `c` is the
  // integer SQLite counted — 0 when nothing matched, never no row.
  const violations = (
    db
      .prepare(
        `SELECT count(*) AS c FROM scope_violations WHERE project_slug = ?`,
      )
      .get(slug) as { c: number }
  ).c;
  const actions = Object.keys(AUDIT_ACTION_KINDS);
  const placeholders = actions.map(() => "?").join(", ");
  // SAFETY: same aggregate guarantee as above — one row, numeric `c`.
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
  options: { limit?: number; filters?: AuditFilters } = {},
): AuditLogEntry[] {
  const limit = options.limit ?? AUDIT_LOG_LIMIT;
  const filters = options.filters ?? {};
  // A rendered-text search must render before it can match, so it scans up to
  // the cap; otherwise fetching `limit` audit rows is enough (violations are
  // always all collected — one row per missing scope).
  const cap = filters.q?.trim() ? AUDIT_SCAN_CAP : limit;
  return collectAuditEntries(db, slug, filters, cap).slice(0, limit);
}
