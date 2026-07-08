import { existsSync, readdirSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  listProjectMembers,
  listProjects,
  listProjectTasks,
} from "~/server/projections/board-query.server";
import { agentProfilesDir } from "~/server/files/file-store-root.server";
import { listUsers } from "~/server/auth/user-store.server";
import { listConnections } from "~/server/org/connections.server";
import {
  createActorResolver,
  initialsOfName,
} from "~/shared/mapping/actor.server";

/**
 * Home (`/`) read models — the project directory + org tile summaries
 * (home spec §3). All aggregates derive from the Phase-3 projections:
 *
 * - `running`: tasks with waiting === "agent" ("agents working") — the
 *   honest Phase-4 stand-in for active runtime runs; Phase 8's run registry
 *   replaces the derivation, not the field.
 * - `waiting`: open decision packets, PROJECT-WIDE (ruling 10 — the
 *   "waiting on you" copy stays, scoping is V1-deliberate).
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

export function listHomeProjects(db: Database.Database): HomeProjectCard[] {
  return listProjects(db).map((project) => {
    const tasks = listProjectTasks(db, project.slug);
    const memberRecords = listProjectMembers(db, project.slug);
    const resolve = createActorResolver(db);
    const members: HomeMember[] = memberRecords.map((m) => {
      const actor = resolve({ kind: "human", userId: m.userId, nameHint: null });
      return actor.kind === "human"
        ? { name: actor.name, initials: actor.initials, tone: actor.tone }
        : { name: m.userId, initials: "?", tone: "" };
    });

    const dist: Record<string, number> = {};
    for (const t of tasks) dist[t.stage] = (dist[t.stage] ?? 0) + 1;
    let updatedAt: string | null = null;
    for (const t of tasks) {
      if (t.updatedAt && (!updatedAt || t.updatedAt > updatedAt)) {
        updatedAt = t.updatedAt;
      }
    }

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
      dist,
      total: tasks.length,
      running: tasks.filter((t) => t.waiting === "agent").length,
      waiting: tasks.filter((t) => t.packet !== null).length,
      members,
      updatedAt: updatedAt ?? project.parsedAt,
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
