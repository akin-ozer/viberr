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
 */

/** The `pr.state` vocabulary stored in task.md (prRefSchema is loose —
 * "closed" extends the phase-3 "review"|"merged" pair per ruling 12). */
export type PrCacheState = "review" | "merged" | "closed";

export function mapPrToCacheState(pr: {
  state: string;
  merged?: boolean;
  merged_at?: string | null;
}): PrCacheState {
  if (pr.merged || pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";
  return "review"; // open + draft both read "in review" (ruling 12)
}

/** Pill rendering contract for the UI step. */
export function prPillFor(state: PrCacheState): {
  label: string;
  kind: "done" | "info" | "risk";
} {
  switch (state) {
    case "merged":
      return { label: "merged", kind: "done" };
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
): Promise<PrLinkResult> {
  const owner = repo.split("/")[0] ?? repo;
  const list = await client.request<GhPullListItem[]>(
    "GET",
    `/repos/${repo}/pulls`,
    {
      searchParams: {
        head: `${owner}:${branch}`,
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

  // Detail fetch for merged flag + change stats (list items omit them).
  const detail = await client.request<GhPullDetail>(
    "GET",
    `/repos/${repo}/pulls/${head.number}`,
  );
  const pr: GhPullDetail = detail.ok ? detail.data : head;
  const state = mapPrToCacheState(pr);
  const headSha = pr.head?.sha ?? head.head?.sha ?? null;

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
