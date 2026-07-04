import type Database from "better-sqlite3";
import {
  getPatToken,
  getProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  createGithubClient,
  type GithubClient,
} from "./github-client.server";

/**
 * Shared "can we talk to GitHub for this project?" resolver. Every GitHub
 * service starts here and turns the two configuration gaps into the typed
 * degraded results the UI renders (`no_pat_configured`,
 * `no_repo_configured`) instead of throwing.
 *
 * Repo resolution: task-level override (task.md `repo`) wins over the
 * project default (projects projection row). Default branch comes from
 * project config (project.md is canonical; the projection mirrors it).
 */

export interface GithubContext {
  status: "ok";
  client: GithubClient;
  /** "owner/name" */
  repo: string;
  owner: string;
  defaultBranch: string;
  patId: string;
}

export type GithubContextFailure =
  | { status: "no_repo_configured" }
  | { status: "no_pat_configured"; repo: string | null };

export type GithubContextResult = GithubContext | GithubContextFailure;

export interface GithubContextOptions {
  /** Task-level repo override (task.md `repo`); null/undefined → project default. */
  repoOverride?: string | null;
  /** Mock-transport hook for tests. */
  fetchImpl?: typeof fetch;
}

export function getProjectGithubContext(
  db: Database.Database,
  projectSlug: string,
  options: GithubContextOptions = {},
): GithubContextResult {
  const projectRow = db
    .prepare(`SELECT repo, default_branch FROM projects WHERE slug = ?`)
    .get(projectSlug) as
    | { repo: string | null; default_branch: string | null }
    | undefined;

  const repo = options.repoOverride ?? projectRow?.repo ?? null;
  if (!repo) return { status: "no_repo_configured" };

  const credential = getProjectCredential(db, projectSlug);
  const token = credential ? getPatToken(db, credential.id) : null;
  if (!credential || token === null) {
    return { status: "no_pat_configured", repo };
  }

  return {
    status: "ok",
    client: createGithubClient({
      token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }),
    repo,
    owner: repo.split("/")[0] ?? repo,
    defaultBranch: projectRow?.default_branch || "main",
    patId: credential.id,
  };
}
