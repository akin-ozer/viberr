import type { DatabaseSync } from "node:sqlite";
import {
  getPatToken,
  getProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  createGithubClient,
  type GithubClient,
  type GithubClientOptions,
} from "./github-client.server";

/**
 * Shared "can we talk to GitHub for this project?" resolver. Every GitHub
 * service starts here and turns the two configuration gaps into the typed
 * degraded results the UI renders (`no_pat_configured`,
 * `no_repo_configured`) instead of throwing.
 *
 * Repo resolution: the project's repo (projects projection row) — ONE project,
 * ONE repo. P13-D-5: a `repoOverride` option used to let a task.md `repo` field
 * win here, but no writer ever set that field and the owner deleted the feature
 * this pass, so the parameter and its four call sites are gone rather than kept
 * as a permanently-undefined read. Default branch comes from project config
 * (project.md is canonical; the projection mirrors it).
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

/** Why a read for the project cannot start, as a read's refusal names it. */
export function githubContextFailureReason(failure: GithubContextFailure): string {
  return failure.status === "no_repo_configured"
    ? "no repository is configured for this project"
    : "no GitHub credential is configured for this project";
}

export interface GithubContextOptions {
  /** Mock-transport hook for tests. */
  fetchImpl?: typeof fetch;
}

export function getProjectGithubContext(
  db: DatabaseSync,
  projectSlug: string,
  options: GithubContextOptions = {},
): GithubContextResult {
  // SAFETY: the SELECT names two `projects` columns — `repo` is nullable TEXT
  // and `default_branch` TEXT NOT NULL DEFAULT 'main' (0001_baseline.sql, so
  // the nullable read below is a defensive widening); `get` returns exactly
  // those two columns for the slug's row, or undefined when there is none.
  const projectRow = db
    .prepare(`SELECT repo, default_branch FROM projects WHERE slug = ?`)
    .get(projectSlug) as
    | { repo: string | null; default_branch: string | null }
    | undefined;

  const repo = projectRow?.repo ?? null;
  if (!repo) return { status: "no_repo_configured" };

  const credential = getProjectCredential(db, projectSlug);
  const token = credential ? getPatToken(db, credential.id) : null;
  if (!credential || token === null) {
    return { status: "no_pat_configured", repo };
  }

  const clientOptions: GithubClientOptions = { token };
  // Optional key: set only when a caller supplied a transport (tests), so the
  // client falls back to global fetch on every production path.
  if (options.fetchImpl) clientOptions.fetchImpl = options.fetchImpl;

  return {
    status: "ok",
    client: createGithubClient(clientOptions),
    repo,
    owner: repo.split("/")[0] ?? repo,
    defaultBranch: projectRow?.default_branch || "main",
    patId: credential.id,
  };
}
