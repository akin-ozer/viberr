import type Database from "better-sqlite3";
import type { AgentProfileView } from "~/features/agents/agent-types";
import { assembleAgentRoster } from "~/features/agents/agents-query.server";
import {
  listMembershipViews,
  type MembershipView,
} from "~/features/project-settings/membership.server";
import { getProject } from "~/server/projections/board-query.server";

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

export interface PolicyViewData {
  projectName: string;
  members: MembershipView[];
  stages: { id: string; name: string; color: string }[];
  transitions: TransitionView[];
  profiles: AgentProfileView[];
  /** Null until a policy change has been audited (fresh seed) — the mock's
   * "Elif Demir · Mar 30" was fixture data; the chip hides when unknown. */
  edited: { by: string; at: string } | null;
}

/** Audit actions that count as "policy changes" for the last-change chip. */
export const POLICY_AUDIT_ACTIONS = [
  "project.member.role_changed",
  "project.policy.boundary_changed",
  "project.agent_profile.created",
  "project.agent_profile.updated",
  "project.agent_profile.deleted",
] as const;

export function latestPolicyChange(
  db: Database.Database,
  projectSlug: string,
): { by: string; at: string } | null {
  const placeholders = POLICY_AUDIT_ACTIONS.map(() => "?").join(", ");
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
  const user = row.actor_user_id
    ? (db.prepare(`SELECT name FROM users WHERE id = ?`).get(row.actor_user_id) as
        | { name: string }
        | undefined)
    : undefined;
  return {
    by: user?.name ?? row.actor_label,
    at: row.occurred_at,
  };
}

export function getPolicyViewData(
  db: Database.Database,
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
    edited: latestPolicyChange(db, projectSlug),
  };
}
