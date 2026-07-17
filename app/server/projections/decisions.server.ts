import type Database from "better-sqlite3";

import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { listProjects } from "~/server/projections/board-query.server";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import { isTerminalStage } from "~/shared/workflow/stage-roles";

/**
 * THE single source of "which open decisions require a given user's action".
 *
 * Every surface that counts or lists decisions ("waiting on you" on Home, the
 * project cards, the notifications overlay, the board chip, the review queue)
 * consults THIS helper instead of its own predicate — so the numbers can never
 * disagree (pass-8 R8-3, replacing three independent non-member-scoped counts).
 *
 * An OPEN decision is one task, in a NON-terminal stage, that carries either an
 * open packet OR ≥1 pending operator recommendation. A task needs exactly one
 * human action, so it contributes exactly one decision (dedupe by task).
 *
 * Member-scoping (the fix): a decision is `mine` iff the user can actually act
 * on it — maintainer+ on that project (resolve-packet / accept-completion /
 * approve-transition all share the maintainer+ tier) OR the task's owner (a
 * contributor who owns a task governs its packet/completion). A decision the
 * user could act on ONLY through the D2 org-admin emergency override (they are
 * an org admin but NOT a project member) is `overrideEligible`, never `mine` —
 * it is governance reach, not a personal inbox. Viewers and non-members with no
 * override see nothing.
 *
 * This is a READ (no audit): it classifies by project role + task ownership
 * directly, never calling the audited `resolveProjectAuthority` mutation path.
 */
export interface DecisionRef {
  projectSlug: string;
  taskKey: string;
  kind: "packet" | "recommendation";
  stage: string;
}

export interface DecisionsForUser {
  /** Open decisions this user is authorized to act on (their real inbox). */
  mine: DecisionRef[];
  /** Open decisions the user could act on ONLY via the org-admin override. */
  overrideEligible: DecisionRef[];
}

interface OpenDecisionRow {
  project_slug: string;
  task_key: string;
  stage: string;
  owner_user_id: string | null;
  has_packet: number;
  recommendation_count: number;
}

export function decisionsRequiring(
  db: Database.Database,
  userId: string,
  opts: { projectSlug?: string } = {},
): DecisionsForUser {
  const orgAdmin = isOrgAdmin(db, userId);

  // This user's project role per project (null = not a member).
  const roleBySlug = new Map<string, ProjectRole>(
    (
      db
        .prepare(`SELECT project_slug, role FROM project_members WHERE user_id = ?`)
        .all(userId) as { project_slug: string; role: ProjectRole }[]
    ).map((r) => [r.project_slug, r.role]),
  );

  // The project stage lists (to exclude terminal-stage tasks — a Done task's
  // leftover packet/recommendation is a resolved decision, not a pending one).
  const stagesBySlug = new Map(listProjects(db).map((p) => [p.slug, p.stages]));

  const rows = db
    .prepare(
      `SELECT project_slug, task_key, stage, owner_user_id,
              (CASE WHEN packet_json IS NOT NULL AND packet_json <> '' THEN 1 ELSE 0 END) AS has_packet,
              recommendation_count
         FROM task_projections
        WHERE ((packet_json IS NOT NULL AND packet_json <> '') OR recommendation_count > 0)
          ${opts.projectSlug ? "AND project_slug = ?" : ""}`,
    )
    .all(...(opts.projectSlug ? [opts.projectSlug] : [])) as OpenDecisionRow[];

  const mine: DecisionRef[] = [];
  const overrideEligible: DecisionRef[] = [];

  for (const row of rows) {
    const stages = stagesBySlug.get(row.project_slug);
    if (!stages || isTerminalStage(row.stage, stages)) continue;

    const role = roleBySlug.get(row.project_slug) ?? null;
    const ref: DecisionRef = {
      projectSlug: row.project_slug,
      taskKey: row.task_key,
      // A task carries at most one open packet; recommendations are otherwise
      // pending. Prefer the packet as the operative decision when both exist.
      kind: row.has_packet ? "packet" : "recommendation",
      stage: row.stage,
    };

    // Maintainer+ holds every governing action; a contributor who OWNS the task
    // governs its packet/completion (rbac.ts owner allowance).
    const canGovern = roleCan(role, "resolve-packet");
    const isOwner =
      row.owner_user_id === userId && roleCan(role, "own-task");

    if (canGovern || isOwner) {
      mine.push(ref);
    } else if (!role && orgAdmin) {
      // Non-member org admin: actionable only through the audited D2 override.
      overrideEligible.push(ref);
    }
    // viewer / contributor-non-owner / non-member-without-override → nothing.
  }

  return { mine, overrideEligible };
}

/** Convenience: per-project `mine` decision counts (Home cards + headline). */
export function myDecisionCountsBySlug(
  db: Database.Database,
  userId: string,
): Map<string, number> {
  const { mine } = decisionsRequiring(db, userId);
  const counts = new Map<string, number>();
  for (const d of mine) counts.set(d.projectSlug, (counts.get(d.projectSlug) ?? 0) + 1);
  return counts;
}
