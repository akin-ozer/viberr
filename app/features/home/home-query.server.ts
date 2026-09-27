import type { DatabaseSync } from "node:sqlite";
import {
  listProjectMembers,
  listProjects,
} from "~/server/projections/board-query.server";
import { listGlobalAgentProfiles } from "~/server/org/gagents.server";
import { readRepoHealthMany } from "~/server/github/repo-health.server";
import type { RepoAccessResult } from "~/server/github/repo-access-check.server";
import { listUsers } from "~/server/auth/user-store.server";
import { listConnections } from "~/server/org/connections.server";
import {
  listKnowledgeBases,
  listMcpServers,
  listSkills,
} from "~/server/org/resources.server";
import { createActorResolver } from "~/shared/mapping/actor.server";
import { initialsOf } from "~/ui/initials";
import { indexDecisionInbox } from "~/server/projections/notifications.server";

/**
 * Home (`/`) read models — the project directory + org tile summaries
 * (home spec §3). Aggregates derive from the store projections, except the
 * live-run count which reads the runtime registry:
 *
 * - `running`: distinct tasks with an `agent_runs` row in
 *   `state = 'running'` — the live run registry, not a `waiting`-field proxy.
 * - `waiting`: LIVE pending decisions this viewer can act on, and
 *   `overrideWaiting` the ones only their org-admin override reaches. Both come
 *   from `indexDecisionInbox` (notifications.server.ts) — the SAME call the
 *   notifications page's "Waiting on you" bucket makes, so the two surfaces
 *   stay in step by construction rather than by comment (E6).
 * - `accent`: stable per-slug hash over the mock palette (the mock's
 *   index-based accents shift when projects are created — spec §8 note 6).
 */

const HOME_ACCENTS = [
  "#5b76fe",
  "#187574",
  "#e8a800",
  "#c2602e",
  "#7b61ff",
  "#00b473",
] as const;

function accentForSlug(slug: string): string {
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
  /** Open decisions THIS viewer can act on (R8-3, member-scoped — set by
   * `listHomeProjectsForUser` from `indexDecisionInbox`). */
  waiting: number;
  /** Open decisions the viewer could act on ONLY via the org-admin override
   * (non-member org admins). Surfaced distinctly, never folded into `waiting`. */
  overrideWaiting: number;
  members: HomeMember[];
  /**
   * Newest task `updated_at` in the project, or `null` when the project has no
   * tasks at all. UI-02: this used to fall back to `project.parsedAt`, which is
   * `nowIso()` at (re)projection time — so "Rebuild projections" (or any
   * restart-time rescan) made every task-less card read "updated just now"
   * although nothing changed. A project with no task activity has no recency
   * signal; the card says so instead of inventing one.
   */
  updatedAt: string | null;
  accent: string;
  /**
   * U33-2: the LAST recorded repository probe for this project, or null when
   * nothing has ever looked. Read from `project_github_health` in one query for
   * the whole list — the card says a repository is unreachable WITHOUT this page
   * calling GitHub, which is the constraint the table exists for.
   */
  repoAccess: RepoAccessResult | null;
}

/**
 * Home project cards VISIBLE to `viewer`. Membership-scoped (owner ruling Q6):
 * a user sees only projects they belong to; an ORG admin sees every project.
 * This matches the inner config-page `requireProjectMember` gating — Home no
 * longer leaks the existence + counts of projects a non-member can't open.
 */
export function listHomeProjectsForUser(
  db: DatabaseSync,
  viewer: { id: string; role: "admin" | "member" },
): HomeProjectCard[] {
  const all = listHomeProjects(db);
  // R8-3: the card's "waiting on you" must mean decisions THIS viewer can act
  // on — not a project-global tally. E6: which decisions those are is decided
  // ONCE, in `indexDecisionInbox`, which the notifications inbox reads too — so
  // the two surfaces that answer "waiting on you" cannot answer it differently.
  // The org-admin override reach is the counter next to it, never inside it.
  const { waitingBySlug, overrideBySlug } = indexDecisionInbox(db, viewer.id);
  const scoped = all.map((p) => ({
    ...p,
    waiting: waitingBySlug.get(p.slug) ?? 0,
    overrideWaiting: overrideBySlug.get(p.slug) ?? 0,
  }));

  if (viewer.role === "admin") return scoped; // org admins see every project
  // Single membership pass (pass-4 WI-9): one query for the slugs this viewer
  // belongs to, instead of re-running listProjectMembers once per project on
  // top of the pass listHomeProjects already made for the member avatars.
  // SAFETY: the row type is the statement's own projection — one NOT NULL
  // column (`project_members.project_slug`, 0001_baseline), named in the SELECT.
  const memberRows = db
    .prepare(`SELECT project_slug FROM project_members WHERE user_id = ?`)
    .all(viewer.id) as { project_slug: string }[];
  const memberSlugs = new Set(memberRows.map((r) => r.project_slug));
  return scoped.filter((p) => memberSlugs.has(p.slug));
}

/** Row of the per-project totals query in `listHomeProjects`. */
type HomeAggRow = {
  project_slug: string;
  total: number;
  updated_at: string | null;
};

/** Per-project task aggregates for the home cards. */
interface HomeTaskAgg {
  total: number;
  running: number;
  updated_at: string | null;
}

/** Every project's card but the per-viewer counts `listHomeProjectsForUser`
 *  adds (R8-3: "waiting on you" is the viewer's own decisions, never a
 *  project-global tally). */
function listHomeProjects(
  db: DatabaseSync,
): Omit<HomeProjectCard, "waiting" | "overrideWaiting">[] {
  const projects = listProjects(db);

  // Push the card counts into SQL (settings-query.server.ts pattern) instead of
  // loading every task row — JSON blob columns and all — into JS just to tally
  // them (pass-4 WI-9). Two GROUP BY queries cover all projects at once.
  //
  // Per-stage distribution.
  const distBySlug = new Map<string, Record<string, number>>();
  // SAFETY: the row type is the SELECT list itself — `project_slug`/`stage` are
  // NOT NULL columns, and the count is an integer on every group the GROUP BY
  // emits.
  const distRows = db
    .prepare(
      `SELECT project_slug, stage, COUNT(*) AS n
       FROM task_projections
       -- R14-3: archived tasks leave the home card's stage bar, the same way
       -- they leave the board's default view.
       WHERE archived = 0
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

  // Per-project totals: task count and the latest updatedAt.
  const aggBySlug = new Map<string, HomeTaskAgg>();
  // SAFETY: same SELECT-list correspondence. `updated_at` is the one nullable
  // column of the three (0001_baseline declares it `TEXT`, not NOT NULL), so
  // `MAX` over a project whose tasks all lack one is null — which is exactly
  // the "no recency signal" the card renders.
  const aggRows = db
    .prepare(
      `SELECT project_slug,
              COUNT(*) AS total,
              MAX(updated_at) AS updated_at
       FROM task_projections
       WHERE archived = 0
       GROUP BY project_slug`,
    )
    .all() as HomeAggRow[];

  // `running` = "agents running" — count the RUNS actually in flight, not the
  // task's waiting=agent governance state. D-5 (pass 24): this was
  // COUNT(DISTINCT task_key), so a task with a live operator AND specialist run
  // (both are `agent_runs` rows) counted as 1 while the card said "1 agent
  // running" and the Agents Live tab showed 2 threads. Count runs so the label,
  // the hero's "N runs active", and the Live tab all agree. `activeIn` (projects
  // with running > 0) is unaffected.
  const runningBySlug = new Map<string, number>();
  // SAFETY: same SELECT-list correspondence — `agent_runs.project_slug` is NOT
  // NULL and COUNT is an integer per group.
  const runningRows = db
    .prepare(
      `SELECT project_slug, COUNT(*) AS running
         FROM agent_runs
        WHERE state = 'running'
        GROUP BY project_slug`,
    )
    .all() as { project_slug: string; running: number }[];
  for (const r of runningRows) runningBySlug.set(r.project_slug, r.running);

  for (const r of aggRows) {
    aggBySlug.set(r.project_slug, {
      total: r.total,
      running: runningBySlug.get(r.project_slug) ?? 0,
      updated_at: r.updated_at,
    });
  }

  // One resolver shared across every project's member list — its per-instance
  // cache means a user shown on multiple projects is looked up once.
  const resolve = createActorResolver(db);

  // U33-2: one query for the whole list, not one per card.
  const repoHealth = readRepoHealthMany(
    db,
    projects.map((p) => p.slug),
  );
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
      members,
      // UI-02: NEVER fall back to `project.parsedAt` — that column is
      // `nowIso()` at projection time, not a change timestamp.
      updatedAt: agg?.updated_at ?? null,
      repoAccess: repoHealth.get(project.slug)?.result ?? null,
      accent: accentForSlug(project.slug),
    };
  });
}

export interface HomeOrgSummary {
  /** GitHub connection owners from the real connections store (Phase 7) — the
   * New-project modal offers these as the repo root. */
  connectionOwners: string[];
  /**
   * UI-09: per-owner credential health. The chip list used to be offered with
   * NO validation filter — unlike the store-import path, which requires
   * `validationState === "valid"` — so a connection whose token had failed was
   * presented as a healthy choice, and the failure only surfaced when the first
   * agent delivery could not push.
   */
  connectionHealth: Record<string, "valid" | "unvalidated" | "failed">;
  users: {
    total: number;
    admins: number;
    members: number;
    /** Disabled accounts inside `total` — disclosed so the tile's population
     * matches the users panel it links to (UI-24). */
    disabled: number;
    first: HomeMember[];
  };
  /** Org agent profile templates on disk (agents/profiles/<id>.md). */
  globalAgents: number;
  knowledgeBases: number;
  mcpServers: number;
  skills: number;
}

export function getHomeOrgSummary(
  db: DatabaseSync,
  options: { dataRoot?: string } = {},
): HomeOrgSummary {
  // Real GitHub connections (Phase 7 store), newest-first via the query, so a
  // freshly-added connection is immediately offered in the New-project modal
  // even before any project references its repo.
  const owners = new Set<string>();
  const connectionHealth: HomeOrgSummary["connectionHealth"] = {};
  for (const c of listConnections(db)) {
    owners.add(c.owner);
    // UI-09: `valid` wins when an owner has several connections — one healthy
    // credential is enough to create against that root.
    if (connectionHealth[c.owner] !== "valid") {
      connectionHealth[c.owner] = c.validationState;
    }
  }

  // UI-24: count EVERY account, the same population the Users & access panel
  // this tile links to reports. Filtering `!disabled` here meant the number
  // changed the moment you clicked the tile. Disabled accounts are disclosed
  // separately instead of being silently dropped.
  const users = listUsers(db);
  const admins = users.filter((u) => u.role === "admin").length;
  const disabled = users.filter((u) => u.disabled).length;

  // F10-21: count SPECIALIST profiles only — the same population the Org
  // Resources catalog lists (`listGlobalAgentProfiles` filters kind, excluding
  // the system operator). Counting every `.md` here (incl. operator.md) made the
  // Home tile say 4 while the catalog showed 3 for no disclosed reason.
  const globalAgents = listGlobalAgentProfiles(db, {
    dataRoot: options.dataRoot,
  }).length;

  // F5: KB & skills are DISK-backed ("disk is truth" — resources.server.ts) and
  // the `org_*` projection rows can lag the folders, so count from the SAME
  // union-of-disk-and-rows listing the org resources page uses (a folder-only
  // skill was counted as 0 on the home tile while it showed on the resources
  // page). MCP servers are DB-only, so their table count is authoritative.
  const resCtx = { dataRoot: options.dataRoot };

  return {
    connectionOwners: [...owners].sort(),
    connectionHealth,
    users: {
      total: users.length,
      admins,
      members: users.length - admins,
      disabled,
      first: users.slice(0, 5).map((u) => ({
        name: u.name,
        initials: initialsOf(u.name),
        tone: u.avatarTone ?? "",
      })),
    },
    globalAgents,
    knowledgeBases: listKnowledgeBases(db, resCtx).length,
    mcpServers: listMcpServers(db).length,
    skills: listSkills(db, resCtx).length,
  };
}
