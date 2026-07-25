import type {
  PrChecks,
  PrMergeable,
  PrReviewState,
  PrState,
} from "~/schemas/task-file.schema";
import type { GithubClient } from "./github-client.server";

/**
 * PR linker (Phase 7): finds the pull request for a task's execution
 * branch, fetches state/draft/merged + a checks summary + (P13-D-28) the
 * review state, and maps real GitHub PR states to the task-file cache
 * vocabulary (orchestrator ruling 12):
 *
 *   merged            → cache "merged"
 *   open (incl draft) → cache "review"
 *   closed-unmerged   → cache "closed"
 *
 * Pill rendering from those cache states lives client-side in
 * `app/features/github/github-pills.ts` (`prStatePill`).
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
  if (pr.merged || pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";
  return "review"; // open + draft both read "in review" (ruling 12)
}

/** One source of truth for the shape — the persisted `pr.checks` schema. */
export type PrChecksSummary = PrChecks;

export interface PrFacts {
  number: number;
  title: string;
  /** Mapped cache state (ruling 12). */
  state: PrCacheState;
  draft: boolean;
  headSha: string | null;
  /** Change stats from the PR (null when the detail fetch failed). */
  changed: { files: number; add: number; del: number } | null;
  /** Check-runs summary for the head sha. `null` = NOT READ (no head sha, or
   * the check-runs call failed) — UNKNOWN, so callers keep the cached value.
   * A repo with no CI reads as `{ total: 0, … }`, which is a real answer. */
  checks: PrChecksSummary | null;
  /** P13-D-28: GitHub review state. The key is ABSENT when the reviews were not
   * read this pass (terminal PR, or the call failed) — UNKNOWN, so callers keep
   * the cached value; `null` means read-and-nothing-outstanding. */
  review?: PrReviewState | null;
  /** P14-LV-07: can GitHub merge this PR? ABSENT when the detail fetch failed
   * (unknown → callers keep the cached value) or the PR is terminal. */
  mergeable?: PrMergeable;
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
  /** P14-LV-07: `null` while GitHub computes it (first read after a push), then
   *  true/false. `mergeable_state` carries the WHY ("dirty" = conflicts). */
  mergeable?: boolean | null;
  mergeable_state?: string;
  /** P13-D-28: who has been ASKED to review (free — the detail fetch already
   *  happens). Distinguishes "review required" from "nobody is expected". */
  requested_reviewers?: { login?: string }[];
  requested_teams?: { slug?: string }[];
}

interface GhCheckRuns {
  total_count: number;
  check_runs: { status: string; conclusion: string | null }[];
}

/** One entry of `GET /pulls/{n}/reviews` — an EVENT log, not a per-reviewer
 *  state: the same person appears once per submitted review. */
export interface GhReview {
  state?: string;
  user?: { login?: string } | null;
}

const PASSING = new Set(["success", "neutral", "skipped"]);
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/**
 * P13-D-28 — the PR's CURRENT review state from GitHub's review EVENT log.
 *
 * `/pulls/{n}/reviews` returns every review ever submitted, oldest first, so
 * the per-reviewer state is that reviewer's LATEST entry. Rules:
 *  - `COMMENTED` / `PENDING` entries are not verdicts and never replace a
 *    reviewer's standing APPROVED / CHANGES_REQUESTED;
 *  - `DISMISSED` IS the reviewer's latest state and withdraws their verdict
 *    (it lands in the map and counts as neither);
 *  - `changes_requested` OUTRANKS `approved` when both are outstanding — one
 *    blocking reviewer is the state that matters;
 *  - with no outstanding verdict, a requested reviewer/team means the PR is
 *    waiting on review; otherwise there is nothing to say (null).
 *
 * KNOWN APPROXIMATION: GitHub removes a reviewer from `requested_reviewers` the
 * moment they rule, so "1 approval + 1 still-requested" reports `approved` here
 * while GitHub's own `reviewDecision` would say REVIEW_REQUIRED if the branch
 * rule demands two. Resolving that needs the branch-protection API (another call
 * per pass); this is a status pill, not the merge gate — the real gate is
 * `mergeTaskPr`'s 405 → `not_mergeable`, which carries GitHub's own message.
 *
 * Exported for direct unit coverage of the ranking matrix.
 */
export function deriveReviewState(
  reviews: readonly GhReview[],
  requestedReviewers: number,
): PrReviewState | null {
  const latestByReviewer = new Map<string, string>();
  for (const review of reviews) {
    const state = (review.state ?? "").toUpperCase();
    if (state === "COMMENTED" || state === "PENDING" || state === "") continue;
    const login = review.user?.login;
    if (!login) continue;
    latestByReviewer.set(login, state);
  }
  const states = [...latestByReviewer.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return requestedReviewers > 0 ? "review_required" : null;
}

/**
 * P14-LV-07 — GitHub's mergeability, mapped to the `pr.mergeable` cache
 * vocabulary. `mergeable` is computed asynchronously, so the first read after a
 * push returns `null` ("unknown"); `mergeable_state: "dirty"` is the conflict.
 * Every other blocked-ness (required reviews, failing checks, behind base)
 * leaves `mergeable: true` and is the merge attempt's business, not this pill's.
 *
 * Exported for direct unit coverage of the three-way mapping.
 */
export function deriveMergeable(pr: {
  mergeable?: boolean | null;
  mergeable_state?: string;
}): PrMergeable {
  if (pr.mergeable === false || pr.mergeable_state === "dirty") {
    return "conflicting";
  }
  if (pr.mergeable === true) return "clean";
  return "unknown";
}

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

  // F26: a reused branch whose newest PR is TERMINAL (merged/closed) must NOT
  // link that stale PR when the branch has advanced past it — e.g. a task key /
  // branch reused across sessions where the prior PR merged and a new delivery
  // force-pushed the branch. Link a terminal PR only when it still represents
  // the branch's CURRENT head (the legitimate accepted / merged-out-of-band
  // divergence case); if the branch moved on, return `none` so `openTaskPr`
  // opens a fresh PR. Fail-safe: if the branch head can't be read (e.g. the head
  // branch was auto-deleted on merge), fall through and link the PR as before.
  if (pr.state === "closed" && headSha) {
    const branchRes = await client.request<{ commit?: { sha?: string } }>(
      "GET",
      `/repos/${repo}/branches/${encodeURIComponent(branch)}`,
    );
    if (branchRes.ok) {
      const branchHead = branchRes.data.commit?.sha ?? null;
      if (branchHead && branchHead !== headSha) {
        return { status: "none" };
      }
    }
  }

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

  // P13-D-28: review-state awareness (prd.md:124) — ONE extra GET, on the same
  // client/timeout/error plumbing, and only for a PR that is still OPEN. A
  // merged/closed PR's review state is settled history, so paying an API call
  // for it on every 5-minute reconcile pass would be exactly the waste this
  // finding was filed about. A failed read leaves `review` ABSENT (unknown) so
  // the caller keeps the cached value instead of blanking the pill.
  let review: PrReviewState | null | undefined;
  if (state === "review") {
    const reviews = await client.request<GhReview[]>(
      "GET",
      `/repos/${repo}/pulls/${head.number}/reviews`,
      { searchParams: { per_page: 100 } },
    );
    if (reviews.ok) {
      review = deriveReviewState(
        Array.isArray(reviews.data) ? reviews.data : [],
        (pr.requested_reviewers?.length ?? 0) + (pr.requested_teams?.length ?? 0),
      );
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
      ...(review !== undefined ? { review } : {}),
      // P14-LV-07: only an OPEN PR has a meaningful mergeability, and only the
      // detail fetch carries it. A failed detail read — or GitHub still
      // COMPUTING the answer (the first read after a push) — leaves the key
      // absent, so the caller keeps the last-known value instead of flapping
      // the pill through "unknown" on every push.
      ...(detail.ok && state === "review" && deriveMergeable(pr) !== "unknown"
        ? { mergeable: deriveMergeable(pr) }
        : {}),
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
