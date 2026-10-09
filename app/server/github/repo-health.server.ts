/**
 * U33-2 (pass 33) — the last repository-access probe, remembered.
 *
 * Creating a project pre-fills the repository name from the project name
 * (pass-8 P1's autocomplete), so a project called "Sandbox" produced
 * `akin-ozer/sandbox`, which does not exist. Creation SUCCEEDED — a 404 on the
 * probe is a warning, not a refusal — the `repoWarning` toast fired once, and
 * after that the fact had no home. The board, the home card and the rail said
 * nothing; only `/projects/:slug/github` showed "repo not found". Meanwhile
 * every agent run in that project died on its clone with git's own
 * `remote: Repository not found`, and nothing on the surface people work on
 * connected the two.
 *
 * This module is the memory that closes it. Every writer is a place that
 * already takes a `RepoAccessResult`: the GitHub page's cached probe, project
 * creation's own probe, a repository change's probe, the reconcile poller's
 * re-check of a failing reading, and the reading a credential or token change
 * takes (`refreshRepoAccess`, ruling 223). So the board and the home card read
 * a row instead of calling GitHub on a hot render path. That constraint is the
 * whole design: a board that phones GitHub on every render would be a worse
 * defect than the one being fixed.
 *
 * Ruling 223: a reading is OF a repository, and a failing one is taken again.
 * Live on 2026-09-27 a board kept saying "akin-ozer/akin-website · repo not
 * found", a repository the owner's account does not have. The row is keyed by
 * project and only the first two writers above wrote it, so changing the
 * repository in Project settings, which probes the new one, left the old
 * repository's verdict on the board (and Home printed that verdict beside the
 * new name), and a repository created on GitHub, or a token given access to
 * it, changed nothing until someone opened the GitHub page. So a reading of
 * any repository but the one the project points at now reads as no reading,
 * and the poller takes every failing reading again (`recheckUnreachableRepos`).
 *
 * The row is an OBSERVATION, not canonical state, so it lives in its own
 * app-owned table rather than a `projects` column: `projects` is a projection of
 * `project.md` and a rebuild would drop anything not derived from the file.
 * Retention is by construction — one row per project, overwritten in place.
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { connectionPill } from "~/features/github/github-pills";
import { logger } from "~/server/logging/logger.server";
import type { GithubContextOptions } from "./github-context.server";
import { checkRepoAccess, type RepoAccessResult } from "./repo-access-check.server";
import { toError } from "~/shared/errors";

/**
 * The stored payload, parsed back into the real union at the boundary.
 *
 * A row outlives the code that wrote it, so this is where a drifted payload has
 * to be caught: an arm that no longer matches reads as "we have no reading" and
 * the surfaces stay quiet, rather than a board loader throwing on a field that
 * moved. The schema MIRRORS `RepoAccessResult`; the assignment below is what
 * makes the mirror check itself, so adding an arm to the type without adding it
 * here fails the typecheck instead of silently dropping that arm's rows.
 */
const storedResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("connected"),
    repo: z.string(),
    remoteDefaultBranch: z.string().nullable(),
    private: z.boolean(),
    // Ruling 227: optional, so a row recorded before it still parses.
    empty: z.boolean().optional(),
    // R-repo-2: the same, for a token that can only read.
    readOnly: z.boolean().optional(),
  }),
  z.object({ status: z.literal("no_repo_configured") }),
  z.object({ status: z.literal("no_pat_configured"), repo: z.string().nullable() }),
  z.object({ status: z.literal("repo_not_found"), repo: z.string() }),
  z.object({
    status: z.literal("auth_failed"),
    repo: z.string(),
    reason: z.enum(["expired", "revoked"]),
  }),
  z.object({
    status: z.literal("org_approval_missing"),
    repo: z.string(),
    message: z.string(),
  }),
  z.object({ status: z.literal("forbidden"), repo: z.string(), message: z.string() }),
  z.object({ status: z.literal("network_unavailable"), repo: z.string() }),
]);

export interface RepoHealthRecord {
  /** The probe result exactly as the writer held it. */
  result: RepoAccessResult;
  checkedAt: string;
}

/**
 * Remember what a probe just answered. Never throws: a board that cannot record
 * an observation must still serve, and the next probe overwrites this one.
 */
export function recordRepoAccess(
  db: DatabaseSync,
  projectSlug: string,
  result: RepoAccessResult,
  now = new Date().toISOString(),
): void {
  try {
    db.prepare(
      `INSERT INTO project_github_health (project_slug, result_json, checked_at)
       VALUES (?, ?, ?)
       ON CONFLICT (project_slug) DO UPDATE SET
         result_json = excluded.result_json,
         checked_at = excluded.checked_at`,
    ).run(projectSlug, JSON.stringify(result), now);
  } catch (error) {
    logger.warn("repository health could not be recorded", {
      projectSlug,
      err: toError(error),
    });
  }
}

/** Drop a project's cached probe. This table is app-owned OBSERVATION keyed by
 *  slug, so a rebuild deliberately does not clear it — which meant a deleted
 *  project's last verdict outlived it and a NEW project reusing the slug was
 *  born wearing the old one's "repository unreachable" badge. */
export function deleteRepoHealth(db: DatabaseSync, projectSlug: string): void {
  db.prepare(`DELETE FROM project_github_health WHERE project_slug = ?`).run(
    projectSlug,
  );
}

/** The remembered probe for one project, or null when none was taken of the
 *  repository it points at now. */
export function readRepoHealth(
  db: DatabaseSync,
  projectSlug: string,
): RepoHealthRecord | null {
  return readRepoHealthMany(db, [projectSlug]).get(projectSlug) ?? null;
}

/**
 * Ruling 223: whether a reading was taken of `repo`, the repository the project
 * points at now. GitHub compares repository names without case, and so does
 * this. A renamed repository's `connected` reading carries GitHub's new name and
 * so reads as no reading, which every surface draws the way it draws
 * `connected`: saying nothing.
 */
function readingIsOf(result: RepoAccessResult, repo: string | null): boolean {
  const of = result.status === "no_repo_configured" ? null : result.repo;
  if (of === null || repo === null) return of === repo;
  return of.toLowerCase() === repo.toLowerCase();
}

/**
 * The remembered probes for a set of projects, in one query — the home page
 * renders every project the viewer can see, and one round trip per card is the
 * shape this table exists to avoid. A project whose reading was taken of
 * another repository (ruling 223) is left out, as one nobody probed is.
 */
export function readRepoHealthMany(
  db: DatabaseSync,
  projectSlugs: readonly string[],
): Map<string, RepoHealthRecord> {
  const out = new Map<string, RepoHealthRecord>();
  if (projectSlugs.length === 0) return out;
  try {
    const placeholders = projectSlugs.map(() => "?").join(", ");
    // SAFETY: `placeholders` is generated from the argument COUNT only — every
    // slug is bound, never interpolated.
    const rows = z
      .array(
        z.object({
          project_slug: z.string(),
          result_json: z.string(),
          checked_at: z.string(),
          repo: z.string().nullable(),
        }),
      )
      .parse(
        db
          .prepare(
            `SELECT h.project_slug, h.result_json, h.checked_at, p.repo
               FROM project_github_health h
               JOIN projects p ON p.slug = h.project_slug
              WHERE h.project_slug IN (${placeholders})`,
          )
          .all(...projectSlugs),
      );
    for (const row of rows) {
      const parsed = storedResultSchema.safeParse(JSON.parse(row.result_json));
      if (!parsed.success) continue;
      // No cast: `parsed.data` IS a `RepoAccessResult` because the schema above
      // mirrors the union arm for arm, and `result` is typed as one — so a new
      // arm on the type that this schema lacks is a typecheck failure here.
      const result: RepoAccessResult = parsed.data;
      if (!readingIsOf(result, row.repo)) continue;
      out.set(row.project_slug, { result, checkedAt: row.checked_at });
    }
  } catch (error) {
    logger.warn("repository health could not be read", {
      err: toError(error),
    });
  }
  return out;
}

/**
 * Whether a reading is one the board's banner and Home's pill show: the
 * `risk`/`blocked` arms of `connectionPill`, where a repository IS configured
 * and GitHub will not serve it. Both surfaces make this test themselves
 * (`repoAccessNotice` in `board-page.tsx`, `RepoLine` in `project-cards.tsx`).
 * It is written a third time here rather than moved beside `connectionPill`
 * for all three to share, because that module sits in a chunk every page
 * loads: moved there, it cost Home 14 B, the board 36 B and the task page
 * 27 B gzip, and those ceilings only move down (ruling 11).
 */
function shownUnreachable(result: RepoAccessResult): boolean {
  const { kind } = connectionPill(result);
  return kind === "risk" || kind === "blocked";
}

/**
 * Ruling 223: take every failing reading again, from the reconcile poller's
 * tick (every five minutes, and once at boot).
 *
 * Only a reading the surfaces show as unreachable is taken again: a healthy
 * project spends no GitHub call here, and a surface's warning can go or change
 * but never appear. An answer that GitHub could not be reached is not
 * recorded, so an outage never hides a failure that is still true. Archived
 * projects are left alone, as the poller leaves them.
 */
export async function recheckUnreachableRepos(
  db: DatabaseSync,
  options: GithubContextOptions = {},
): Promise<void> {
  const slugs = z
    .array(z.object({ slug: z.string() }))
    .parse(
      db
        .prepare(
          `SELECT h.project_slug AS slug
             FROM project_github_health h
             JOIN projects p ON p.slug = h.project_slug
            WHERE p.archived = 0`,
        )
        .all(),
    )
    .map((row) => row.slug);
  for (const [slug, reading] of readRepoHealthMany(db, slugs)) {
    if (!shownUnreachable(reading.result)) continue;
    try {
      const fresh = await checkRepoAccess(db, slug, options);
      if (fresh.status !== "network_unavailable") recordRepoAccess(db, slug, fresh);
    } catch (error) {
      logger.warn("repository health could not be re-checked", {
        projectSlug: slug,
        err: toError(error),
      });
    }
  }
}
