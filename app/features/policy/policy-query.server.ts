import type { DatabaseSync } from "node:sqlite";
import type { Guardrail } from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { DEFAULT_GUARDRAILS } from "~/shared/workflow/templates";
import {
  DEFAULT_GUARDRAIL_IDS,
  guardrailKind,
  guardrailLabel,
  type GuardrailKind,
} from "~/shared/workflow/guardrail-labels";
import type { AgentProfileView } from "~/features/agents/agent-types";
import { assembleAgentRoster } from "~/features/agents/agents-query.server";
import {
  listMembershipViews,
  type MembershipView,
} from "~/features/project-settings/membership.server";
import { getProject } from "~/server/projections/board-query.server";
import {
  readRequiredReviewers,
  type RequiredReviewerView,
} from "~/server/tasks/required-reviewers.server";

/**
 * Policy view read model (policy spec §3): members + roles from the
 * canonical membership store, workflow transitions + stages from the
 * project projection, the assembled agent-profile roster (shared with the
 * Agents surface), and the "last change" chip derived from the newest
 * policy-shaped audit event (never a stored blob field — spec §3.1).
 */

export interface TransitionView {
  from: string;
  to: string;
  by: string;
  boundary: "auto" | "approval" | "human";
  locked: boolean;
}

/**
 * E32-6 (pass 32): one project.md `guardrails` row as the Policy card shows
 * it. `kind` decides the control: a `default` row is the runtime-enforced
 * anti-noise set (toggle; `value` field when it carries a `unit`), a `github`
 * row is owned by Settings → GitHub (inert, with a pointer), an `unknown` row
 * is a retired or hand-written id nothing reads (inert, removable).
 * `present` is false for a default the file does not carry (a project created
 * before the defaults shipped, or a hand edit that dropped it): rendered OFF
 * with that said, and toggling it on writes the row.
 */
export interface GuardrailView {
  id: string;
  label: string;
  desc: string;
  on: boolean;
  value: number | null;
  unit: string | null;
  kind: GuardrailKind;
  present: boolean;
}

export interface PolicyViewData {
  projectName: string;
  members: MembershipView[];
  stages: { id: string; name: string; color: string }[];
  transitions: TransitionView[];
  profiles: AgentProfileView[];
  guardrails: GuardrailView[];
  /** Ruling 178: the project's required reviewers (stage → agent), read
   *  from project.md and resolved to names. Edited on Settings. */
  requiredReviewers: RequiredReviewerView[];
  /** Null until a policy change has been audited (fresh seed) — the mock's
   * "Elif Demir · Mar 30" was fixture data; the chip hides when unknown. */
  /** UXA-16: the raw timestamp — the DISPLAY form is the client's job. This
   *  used to ship a pre-formatted `t` built with `formatDayBucket` on the
   *  server, so in a UTC container the Policy header showed the SERVER's
   *  calendar day while every other timestamp in the app is viewer-local (and
   *  it carried no year, so "Mar 30" could be any year). */
  edited: { by: string; at: string } | null;
}

/** Audit actions that count as "policy changes" for the last-change chip. */
export const POLICY_AUDIT_ACTIONS = [
  "project.member.role_changed",
  "project.policy.boundary_changed",
  "project.policy.guardrail_changed",
  // Ruling 178: the required-reviewer rule is acceptance policy.
  "project.required_reviewers.updated",
  "project.agent_profile.created",
  "project.agent_profile.updated",
  "project.agent_profile.deleted",
] as const;

export function latestPolicyChange(
  db: DatabaseSync,
  projectSlug: string,
): { by: string; at: string } | null {
  const placeholders = POLICY_AUDIT_ACTIONS.map(() => "?").join(", ");
  // SAFETY: 0001_baseline declares all three projected `audit_events` columns
  // TEXT — `occurred_at` and `actor_label` NOT NULL, `actor_user_id` nullable
  // (the system/operator actors record no user id). `LIMIT 1` yields at most
  // one row, and none at all for a project with no policy audit yet.
  const row = db
    .prepare(
      `SELECT occurred_at, actor_user_id, actor_label FROM audit_events
        WHERE project_slug = ? AND action IN (${placeholders})
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    )
    .get(projectSlug, ...POLICY_AUDIT_ACTIONS) as
    | { occurred_at: string; actor_user_id: string | null; actor_label: string }
    | undefined;
  if (!row) return null;
  // SAFETY: `users.name` is TEXT NOT NULL and `id` is the primary key, so the
  // lookup answers with exactly that one column or with no row at all — an
  // actor whose account has since been deleted falls back to `actor_label`.
  const user = row.actor_user_id
    ? (db.prepare(`SELECT name FROM users WHERE id = ?`).get(row.actor_user_id) as
        | { name: string }
        | undefined)
    : undefined;
  return { by: user?.name ?? row.actor_label, at: row.occurred_at };
}

export function getPolicyViewData(
  db: DatabaseSync,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): PolicyViewData | null {
  const project = getProject(db, projectSlug);
  if (!project) return null;
  return {
    projectName: project.name,
    members: listMembershipViews(db, projectSlug, ctx),
    stages: project.stages.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
    })),
    transitions: project.workflow.map((w) => ({
      from: w.from,
      to: w.to,
      by: w.by,
      boundary: w.boundary,
      locked: w.locked,
    })),
    profiles: assembleAgentRoster(db, projectSlug, ctx),
    guardrails: listGuardrailViews(projectSlug, ctx),
    requiredReviewers: readRequiredReviewers(projectSlug, ctx),
    edited: latestPolicyChange(db, projectSlug),
  };
}

/** Every default guardrail (present or not) in shipped order, then whatever
 *  else project.md carries, in file order. */
export function listGuardrailViews(
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): GuardrailView[] {
  const stored =
    readProjectFile({ projectSlug, dataRoot: ctx.dataRoot })?.parsed.frontmatter
      .guardrails ?? [];
  // Review F13 (pass 32): FIRST occurrence wins, the same row `setGuardrail`'s
  // `findIndex` mutates — a hand-edited file carrying an id twice must not show
  // one row's state while the toggle writes the other.
  const byId = new Map<string, Guardrail>();
  for (const g of stored) if (!byId.has(g.id)) byId.set(g.id, g);
  const view = (g: Guardrail, present: boolean): GuardrailView => ({
    id: g.id,
    label: guardrailLabel(g.id),
    desc: g.desc,
    on: g.on,
    value: g.value ?? null,
    unit: g.unit ?? null,
    kind: guardrailKind(g.id),
    present,
  });
  const defaults = DEFAULT_GUARDRAILS.map((d) => {
    const row = byId.get(d.id);
    return row ? view(row, true) : view({ ...d, on: false }, false);
  });
  const extras = stored
    .filter((g) => !DEFAULT_GUARDRAIL_IDS.includes(g.id))
    .map((g) => view(g, true));
  return [...defaults, ...extras];
}
