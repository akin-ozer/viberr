import type { PrState } from "~/schemas/task-file.schema";
import type { GithubClient } from "./github-client.server";

/**
 * PR linker (Phase 7): finds the pull request for a task's execution
 * branch, fetches state/draft/merged + a checks summary, and maps real
 * GitHub PR states to the task-file cache vocabulary + mock pill kinds
 * (orchestrator ruling 12):
 *
 *   merged            → cache "merged" → done pill "merged"
 *   open (incl draft) → cache "review" → info pill "in review"
 *   closed-unmerged   → cache "closed" → risk pill "closed"
 *
 * Plus one state GitHub never reports but Viberr sets itself: "accepted" — a
 * human accepted the completion but the REAL merge couldn't run (no reachable
 * GitHub / not mergeable). It means "accepted, merge pending" and keeps the
 * task record honest instead of claiming a merge that didn't happen.
 */

/** The `pr.state` vocabulary stored in task.md — the prRefSchema enum
 * (PR_STATE_VALUES): "closed" extends the phase-3 "review"|"merged" pair per
 * ruling 12; "accepted" = human-accepted, real merge pending. */
export type PrCacheState = PrState;

export function mapPrToCacheState(pr: {
  state: string;
  merged?: boolean;
  merged_at?: string | null;
}): PrCacheState {
  const state = pr.state.toLowerCase();
  if (pr.merged || pr.merged_at || state === "merged") return "merged";
  if (state === "closed") return "closed";
  return "review"; // open + draft both read "in review" (ruling 12)
}

/** Pill rendering contract for the UI step (mirrored client-side by
 * `github-pills.prStatePill` — keep the two in lockstep). */
export function prPillFor(state: PrCacheState): {
  label: string;
  kind: "done" | "info" | "risk" | "input";
} {
  switch (state) {
    case "merged":
      return { label: "merged", kind: "done" };
    case "accepted":
      return { label: "merge pending", kind: "input" };
    case "closed":
      return { label: "closed", kind: "risk" };
    default:
      return { label: "in review", kind: "info" };
  }
}

export interface PrChecksSummary {
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

export interface PrFacts {
  number: number;
  title: string;
  /** Mapped cache state (ruling 12). */
  state: PrCacheState;
  draft: boolean;
  headSha: string | null;
  baseRepo: string | null;
  baseRef: string | null;
  /** Change stats from the PR (null when the detail fetch failed). */
  changed: { files: number; add: number; del: number } | null;
  /** Check-runs summary for the head sha (null when unavailable). */
  checks: PrChecksSummary | null;
}

export type PrLinkResult =
  | { status: "found"; pr: PrFacts }
  | { status: "none" }
  | { status: "forbidden"; message: string }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

interface GhPullListItem {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged_at: string | null;
  head?: { sha?: string };
  base?: { ref?: string; repo?: { full_name?: string } };
}

interface GhPullDetail extends GhPullListItem {
  merged?: boolean;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

interface GhCheckRuns {
  total_count: number;
  check_runs: { status: string; conclusion: string | null }[];
}

const PASSING = new Set(["success", "neutral", "skipped"]);
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/**
 * Finds the newest PR whose head is `branch` (any state), then fetches the
 * PR detail (merged flag + change stats) and a check-runs summary.
 */
export async function findPrForBranch(
  client: GithubClient,
  repo: string,
  branch: string,
  expectedDefaultBranch?: string,
): Promise<PrLinkResult> {
  const owner = repo.split("/")[0] ?? repo;
  const list = await client.request<GhPullListItem[]>(
    "GET",
    `/repos/${repo}/pulls`,
    {
      searchParams: {
        head: `${owner}:${branch}`,
        ...(expectedDefaultBranch ? { base: expectedDefaultBranch } : {}),
        state: "all",
        sort: "created",
        direction: "desc",
        per_page: 5,
      },
    },
  );
  if (!list.ok) {
    if (list.kind === "network") {
      return { status: "network_unavailable", message: list.message };
    }
    if (list.kind === "http" && list.status === 401) {
      return { status: "auth_failed", message: list.message };
    }
    if (list.kind === "http" && (list.status === 403 || list.status === 404)) {
      // Fine-grained tokens without pull-request read report 403 (or mask
      // the repo as 404) — surface as forbidden, the caller decides.
      return { status: "forbidden", message: list.message };
    }
    return {
      status: "network_unavailable",
      message: list.kind === "http" ? list.message : "unknown",
    };
  }
  const head = list.data[0];
  if (!head) return { status: "none" };
  if (
    expectedDefaultBranch &&
    (head.base?.ref !== expectedDefaultBranch ||
      head.base?.repo?.full_name?.trim().toLowerCase() !==
        repo.trim().toLowerCase())
  ) {
    return { status: "none" };
  }

  // Detail fetch for merged flag + change stats (list items omit them).
  const detail = await client.request<GhPullDetail>(
    "GET",
    `/repos/${repo}/pulls/${head.number}`,
  );
  const pr: GhPullDetail = detail.ok ? detail.data : head;
  if (
    expectedDefaultBranch &&
    (pr.base?.ref !== expectedDefaultBranch ||
      pr.base?.repo?.full_name?.trim().toLowerCase() !==
        repo.trim().toLowerCase())
  ) {
    return { status: "none" };
  }
  const state = mapPrToCacheState(pr);
  const headSha = pr.head?.sha ?? head.head?.sha ?? null;
  const baseRepo =
    pr.base?.repo?.full_name ?? head.base?.repo?.full_name ?? null;
  const baseRef = pr.base?.ref ?? head.base?.ref ?? null;

  let checks: PrChecksSummary | null = null;
  if (headSha) {
    const checkRuns = await client.request<GhCheckRuns>(
      "GET",
      `/repos/${repo}/commits/${headSha}/check-runs`,
      { searchParams: { per_page: 100 } },
    );
    if (checkRuns.ok) {
      const runs = checkRuns.data.check_runs ?? [];
      const passing = runs.filter(
        (r) => r.conclusion !== null && PASSING.has(r.conclusion),
      ).length;
      const failing = runs.filter(
        (r) => r.conclusion !== null && FAILING.has(r.conclusion),
      ).length;
      checks = {
        total: checkRuns.data.total_count ?? runs.length,
        passing,
        failing,
        pending: runs.filter((r) => r.conclusion === null).length,
      };
    }
  }

  return {
    status: "found",
    pr: {
      number: pr.number,
      title: pr.title,
      state,
      draft: pr.draft ?? false,
      headSha,
      baseRepo,
      baseRef,
      changed:
        detail.ok &&
        typeof pr.changed_files === "number" &&
        typeof pr.additions === "number" &&
        typeof pr.deletions === "number"
          ? { files: pr.changed_files, add: pr.additions, del: pr.deletions }
          : null,
      checks,
    },
  };
}
