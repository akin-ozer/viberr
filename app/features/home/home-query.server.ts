import { existsSync, readdirSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  listProjectMembers,
  listProjects,
} from "~/server/projections/board-query.server";
import { agentProfilesDir } from "~/server/files/file-store-root.server";
import { listUsers } from "~/server/auth/user-store.server";
import { listConnections } from "~/server/org/connections.server";
import {
  createActorResolver,
  initialsOfName,
} from "~/shared/mapping/actor.server";
import { roleCan, type ProjectRole } from "~/shared/rbac";

/**
 * Home (`/`) read models — the project directory + org tile summaries
 * (home spec §3). All aggregates derive from the Phase-3 projections:
 *
 * - `running`: real live runtime rows, excluding simulated/demo sessions.
 * - `waiting`: human decisions routed to this viewer by explicit project role
 *   or task ownership. Emergency org-admin access does not inflate the count.
 * - `accent`: stable per-slug hash over the mock palette (the mock's
 *   index-based accents shift when projects are created — spec §8 note 6).
 */

export const HOME_ACCENTS = [
  "#5b76fe",
  "#187574",
  "#e8a800",
  "#c2602e",
  "#7b61ff",
  "#00b473",
] as const;

export function accentForSlug(slug: string): string {
  let h = 5381;
  for (let i = 0; i < slug.length; i++) h = (h * 33) ^ slug.charCodeAt(i);
  return HOME_ACCENTS[Math.abs(h) % HOME_ACCENTS.length]!;
}

export interface HomeMember {
  name: string;
  initials: string;
  tone: string;
}

export interface HomeProjectCard {
  slug: string;
  name: string;
  archived: boolean;
  /** Task key prefix ("VIB"). */
  key: string;
  repo: string | null;
  desc: string;
  /** The project's OWN stages (ruling 15) — StageMeter iterates these. */
  stages: { id: string; name: string; color: string }[];
  /** stageId → task count. */
  dist: Record<string, number>;
  total: number;
  running: number;
  waiting: number;
  members: HomeMember[];
  updatedAt: string | null;
  accent: string;
}

/**
 * Home project cards VISIBLE to `viewer`. Membership-scoped (owner ruling Q6):
 * a user sees only projects they belong to; an ORG admin sees every project.
 * This matches the inner config-page `requireProjectMember` gating — Home no
 * longer leaks the existence + counts of projects a non-member can't open.
 */
export function listHomeProjectsForUser(
  db: Database.Database,
  viewer: { id: string; role: "admin" | "member" },
): HomeProjectCard[] {
  const all = listHomeProjects(db);
  // Single membership pass (pass-4 WI-9): one query for the slugs this viewer
  // belongs to, instead of re-running listProjectMembers once per project on
  // top of the pass listHomeProjects already made for the member avatars.
  const memberships = db
    .prepare(`SELECT project_slug, role FROM project_members WHERE user_id = ?`)
    .all(viewer.id) as { project_slug: string; role: ProjectRole }[];
  const roleBySlug = new Map(memberships.map((m) => [m.project_slug, m.role]));
  const visible =
    viewer.role === "admin"
      ? all
      : all.filter((p) => roleBySlug.has(p.slug));
  const supervisorCount = db.prepare(
    `SELECT COUNT(*) AS c FROM task_projections
     WHERE project_slug = ? AND waiting = 'human'`,
  );
  const ownerCount = db.prepare(
    `SELECT COUNT(*) AS c FROM task_projections
     WHERE project_slug = ? AND waiting = 'human' AND owner_user_id = ?`,
  );
  return visible.map((project) => {
    const role = roleBySlug.get(project.slug) ?? null;
    const waiting = roleCan(role, "resolve-packet")
      ? (supervisorCount.get(project.slug) as { c: number }).c
      : roleCan(role, "own-task")
        ? (ownerCount.get(project.slug, viewer.id) as { c: number }).c
        : 0;
    return { ...project, waiting };
  });
}

/** Per-project task aggregates for the home cards. */
interface HomeTaskAgg {
  total: number;
  running: number;
  waiting: number;
  updated_at: string | null;
}

export function listHomeProjects(db: Database.Database): HomeProjectCard[] {
  const projects = listProjects(db);

  // Push the card counts into SQL (settings-query.server.ts pattern) instead of
  // loading every task row — JSON blob columns and all — into JS just to tally
  // them (pass-4 WI-9). Two GROUP BY queries cover all projects at once.
  //
  // Per-stage distribution:
  const distBySlug = new Map<string, Record<string, number>>();
  const distRows = db
    .prepare(
      `SELECT project_slug, stage, COUNT(*) AS n FROM task_projections
       GROUP BY project_slug, stage`,
    )
    .all() as { project_slug: string; stage: string; n: number }[];
  for (const r of distRows) {
    let d = distBySlug.get(r.project_slug);
    if (!d) {
      d = {};
      distBySlug.set(r.project_slug, d);
    }
    d[r.stage] = r.n;
  }

  // Per-project totals: task count, REAL active runtime rows, open decision
  // packets, and latest task update. A task's waiting flag is governance state,
  // not proof that a process exists; simulated seed rows are demo evidence and
  // must never inflate Home's "agents running" claim.
  const aggBySlug = new Map<string, HomeTaskAgg>();
  const aggRows = db
    .prepare(
      `SELECT project_slug,
              COUNT(*) AS total,
              (SELECT COUNT(*) FROM agent_runs r
                WHERE r.project_slug = task_projections.project_slug
                  AND r.state = 'running'
                  AND r.simulated = 0) AS running,
              SUM(CASE WHEN packet_json IS NOT NULL AND packet_json <> ''
                       THEN 1 ELSE 0 END) AS waiting,
              MAX(updated_at) AS updated_at
       FROM task_projections
       GROUP BY project_slug`,
    )
    .all() as (HomeTaskAgg & { project_slug: string })[];
  for (const r of aggRows) {
    aggBySlug.set(r.project_slug, {
      total: r.total,
      running: r.running,
      waiting: r.waiting,
      updated_at: r.updated_at,
    });
  }

  // One resolver shared across every project's member list — its per-instance
  // cache means a user shown on multiple projects is looked up once.
  const resolve = createActorResolver(db);

  return projects.map((project) => {
    const memberRecords = listProjectMembers(db, project.slug);
    const members: HomeMember[] = memberRecords.map((m) => {
      const actor = resolve({ kind: "human", userId: m.userId, nameHint: null });
      return actor.kind === "human"
        ? { name: actor.name, initials: actor.initials, tone: actor.tone }
        : { name: m.userId, initials: "?", tone: "" };
    });

    const agg = aggBySlug.get(project.slug);
    return {
      slug: project.slug,
      name: project.name,
      archived: project.archived,
      key: project.taskPrefix,
      repo: project.repo,
      desc: project.description,
      stages: project.stages.map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
      })),
      dist: distBySlug.get(project.slug) ?? {},
      total: agg?.total ?? 0,
      running: agg?.running ?? 0,
      waiting: agg?.waiting ?? 0,
      members,
      updatedAt: agg?.updated_at ?? project.parsedAt,
      accent: accentForSlug(project.slug),
    };
  });
}

export interface HomeOrgSummary {
  /** GitHub connection owners from the real connections store (Phase 7) — the
   * New-project modal offers these as the repo root. */
  connectionOwners: string[];
  users: {
    total: number;
    admins: number;
    members: number;
    first: HomeMember[];
  };
  /** Org agent profile templates on disk (agents/profiles/<id>.md). */
  globalAgents: number;
  knowledgeBases: number;
  mcpServers: number;
  skills: number;
}

export function getHomeOrgSummary(
  db: Database.Database,
  options: { dataRoot?: string } = {},
): HomeOrgSummary {
  // Real GitHub connections (Phase 7 store), newest-first via the query, so a
  // freshly-added connection is immediately offered in the New-project modal
  // even before any project references its repo.
  const owners = new Set<string>();
  for (const c of listConnections(db)) owners.add(c.owner);

  const users = listUsers(db).filter((u) => !u.disabled);
  const admins = users.filter((u) => u.role === "admin").length;

  let globalAgents = 0;
  const profilesDir = agentProfilesDir(options.dataRoot);
  if (existsSync(profilesDir)) {
    globalAgents = readdirSync(profilesDir).filter((f) =>
      f.endsWith(".md"),
    ).length;
  }

  const countOf = (table: string): number =>
    (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;

  return {
    connectionOwners: [...owners].sort(),
    users: {
      total: users.length,
      admins,
      members: users.length - admins,
      first: users.slice(0, 5).map((u) => ({
        name: u.name,
        initials: initialsOfName(u.name),
        tone: u.avatarTone ?? "",
      })),
    },
    globalAgents,
    // Real counts from the 9B org-resource tables (migration 0008); the
    // phase-4 loader predated them (Phase 10 closed the honest-zeros gap).
    knowledgeBases: countOf("org_knowledge_bases"),
    mcpServers: countOf("org_mcp_servers"),
    skills: countOf("org_skills"),
  };
}
