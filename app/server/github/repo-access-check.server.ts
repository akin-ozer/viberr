import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  getProjectGithubContext,
  type GithubContextOptions,
} from "./github-context.server";
import type { GithubClient } from "./github-client.server";
import {
  repoPermissionsSchema,
  repoWritable,
} from "~/server/secrets/pat-validator.server";

/**
 * Repo access check (Phase 7): the "Connection" fact for the GitHub view's
 * Repository panel. Always returns a typed result — degraded states
 * (`no_pat_configured`, `network_unavailable`, …) render as non-`ready`
 * pills instead of crashing the page.
 */

export type RepoAccessResult =
  | {
      status: "connected";
      repo: string;
      /** GitHub's actual default branch (may differ from project config). */
      remoteDefaultBranch: string | null;
      private: boolean;
      /**
       * Ruling 227(a): the repository has no commit at all. Viberr creates
       * the default branch's first commit itself before the first task
       * branch, so this is a fact to state, not a failure. Absent on an
       * older recorded result.
       */
      empty?: boolean;
      /**
       * GitHub's permissions block says this token can read the repository
       * but not push to it (`repoWritable` false). An empty repository then
       * gets no first commit from Viberr until the token can write, so every
       * surface that says Viberr will make one says this instead (pre-merge
       * review of pass 40, R-repo-2). Absent when it can push or GitHub sent
       * no block.
       */
      readOnly?: boolean;
    }
  | { status: "no_repo_configured" }
  | { status: "no_pat_configured"; repo: string | null }
  | { status: "repo_not_found"; repo: string }
  | { status: "auth_failed"; repo: string; reason: "expired" | "revoked" }
  | { status: "org_approval_missing"; repo: string; message: string }
  | { status: "forbidden"; repo: string; message: string }
  | { status: "network_unavailable"; repo: string };

/** `GET /repos/{r}` — every field is read with a fallback, so each parses to
 *  `undefined` on drift and the reads degrade exactly as they always did. */
const ghRepoSchema = z
  .object({
    full_name: z.string().optional().catch(undefined),
    private: z.boolean().optional().catch(undefined),
    default_branch: z.string().optional().catch(undefined),
    size: z.number().optional().catch(undefined),
    // Decoded by `repoPermissionsSchema` where it is read, not here: the
    // validator's module can be mid-evaluation when this one loads.
    permissions: z.unknown().optional(),
  })
  .catch({});

/**
 * Ruling 227 (F40-12): whether a repository has no commit at all. `size: 0`
 * on `GET /repos/{r}` is only the cue (GitHub computes it lazily, so a fresh
 * repository with commits can read 0 too); the proof is the commits read,
 * which GitHub answers 409 "Git Repository is empty." on a repository with no
 * commit. Only a size-0 repository pays the second call. Anything but that
 * 409 (a commit, a refusal, a failure) reads as "not shown to be empty".
 */
export async function repositoryIsEmpty(
  client: GithubClient,
  repo: string,
  size: number | undefined,
): Promise<boolean> {
  if (size !== 0) return false;
  const commits = await client.request("GET", `/repos/${repo}/commits`, z.unknown(), {
    searchParams: { per_page: 1 },
  });
  return !commits.ok && commits.kind === "http" && commits.status === 409;
}

export async function checkRepoAccess(
  db: DatabaseSync,
  projectSlug: string,
  options: GithubContextOptions = {},
): Promise<RepoAccessResult> {
  const ctx = getProjectGithubContext(db, projectSlug, options);
  if (ctx.status !== "ok") return ctx;

  const result = await ctx.client.request("GET", `/repos/${ctx.repo}`, ghRepoSchema);
  if (result.ok) {
    const connected: RepoAccessResult = {
      status: "connected",
      repo: result.data.full_name ?? ctx.repo,
      remoteDefaultBranch: result.data.default_branch ?? null,
      private: result.data.private ?? false,
    };
    if (await repositoryIsEmpty(ctx.client, ctx.repo, result.data.size)) connected.empty = true;
    const permissions = repoPermissionsSchema.optional().catch(undefined).parse(result.data.permissions);
    if (repoWritable(permissions) === false) connected.readOnly = true;
    return connected;
  }
  if (result.kind === "network") {
    return { status: "network_unavailable", repo: ctx.repo };
  }
  if (result.kind === "http") {
    if (result.status === 401) {
      return {
        status: "auth_failed",
        repo: ctx.repo,
        reason: /expired/i.test(result.message) ? "expired" : "revoked",
      };
    }
    if (result.status === 404) {
      return { status: "repo_not_found", repo: ctx.repo };
    }
    if (result.status === 403) {
      if (/approval|access policy|organization/i.test(result.message)) {
        return {
          status: "org_approval_missing",
          repo: ctx.repo,
          message: result.message,
        };
      }
      return { status: "forbidden", repo: ctx.repo, message: result.message };
    }
  }
  return { status: "network_unavailable", repo: ctx.repo };
}
