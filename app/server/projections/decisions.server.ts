import type { DatabaseSync } from "node:sqlite";

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
 * approve-transition all share the maintainer+ tier) OR the task's owner acting
 * within the NARROW owner exception (Q2/R6-2): an owner governs its packet and
 * its `accept_completion` recommendation, but NOT transition/assign/run
 * recommendations (maintainer-only — an owner would 403 on both apply AND
 * dismiss). A decision the user could act on ONLY through the D2 org-admin
 * emergency override (org admin whose own project role — none, viewer, or a
 * below-tier membership — is insufficient) is `overrideEligible`, never `mine`:
 * governance reach, not a personal inbox. Viewers and contributor-non-owners
 * with no override see nothing.
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

/** Does the projected recommendation-kinds array contain an owner-actionable
 * `accept_completion`? Tolerant of a malformed/legacy value (treated as none). */
function hasAcceptCompletionRec(recommendationKinds: string): boolean {
  try {
    const kinds = JSON.parse(recommendationKinds) as unknown;
    return Array.isArray(kinds) && kinds.includes("accept_completion");
  } catch {
    return false;
  }
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
  recommendation_kinds: string;
}

export function decisionsRequiring(
  db: DatabaseSync,
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
              recommendation_count, recommendation_kinds
         FROM task_projections
        WHERE ((packet_json IS NOT NULL AND packet_json <> '') OR recommendation_count > 0)
          ${opts.projectSlug ? "AND project_slug = ?" : ""}`,
    )
    .all(...(opts.projectSlug ? [opts.projectSlug] : [])) as unknown as OpenDecisionRow[];

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

    // Maintainer+ holds every governing action (resolve-packet / accept-
    // completion / approve-transition / dismiss-recommendation all share the
    // maintainer+ tier), so a maintainer+ can act on ANY open decision.
    const canGovern = roleCan(role, "resolve-packet");
    // The task OWNER exception (Q2/R6-2) is NARROW: an owner (contributor+) can
    // resolve its packet and accept its completion — but NOT act on transition/
    // assign/run recommendations (those need approve-transition/run-agents, and
    // even DISMISSING a recommendation needs resolve-packet, none with an owner
    // exception). So an owner's decision is `mine` only when it is a packet OR an
    // `accept_completion` recommendation; a maintainer-only recommendation on an
    // owned task is NOT the owner's to act on (it would 403 on apply and dismiss).
    const isOwner = row.owner_user_id === userId && roleCan(role, "own-task");
    const ownerCanAct =
      isOwner &&
      (row.has_packet === 1 || hasAcceptCompletionRec(row.recommendation_kinds));

    if (canGovern || ownerCanAct) {
      mine.push(ref);
    } else if (orgAdmin) {
      // Org admin who can't act under their own project role (non-member, viewer,
      // or a below-tier member) — actionable only through the audited D2 override
      // (resolveProjectAuthority grants it whenever the member role is below the
      // required tier, not only to non-members).
      overrideEligible.push(ref);
    }
    // viewer / contributor-non-owner (or owner of a maintainer-only rec) with no
    // org-admin override → nothing.
  }

  return { mine, overrideEligible };
}
