import type { DatabaseSync } from "node:sqlite";
import {
  getProjectGithubContext,
  type GithubContextOptions,
} from "./github-context.server";

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
    }
  | { status: "no_repo_configured" }
  | { status: "no_pat_configured"; repo: string | null }
  | { status: "repo_not_found"; repo: string }
  | { status: "auth_failed"; repo: string; reason: "expired" | "revoked" }
  | { status: "org_approval_missing"; repo: string; message: string }
  | { status: "forbidden"; repo: string; message: string }
  | { status: "network_unavailable"; repo: string };

interface GhRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
}

export async function checkRepoAccess(
  db: DatabaseSync,
  projectSlug: string,
  options: GithubContextOptions = {},
): Promise<RepoAccessResult> {
  const ctx = getProjectGithubContext(db, projectSlug, options);
  if (ctx.status !== "ok") return ctx;

  const result = await ctx.client.request<GhRepo>("GET", `/repos/${ctx.repo}`);
  if (result.ok) {
    return {
      status: "connected",
      repo: result.data.full_name ?? ctx.repo,
      remoteDefaultBranch: result.data.default_branch ?? null,
      private: result.data.private ?? false,
    };
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
