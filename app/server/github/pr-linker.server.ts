import { PR_PATHS_MAX } from "~/schemas/task-file.schema";
import { z } from "zod";
import type {
  PrChecks,
  PrMergeable,
  PrReviewState,
  PrState,
} from "~/schemas/task-file.schema";
import { logger } from "~/server/logging/logger.server";
import {
  githubFailureMessage,
  type GithubClient,
} from "./github-client.server";

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

/**
 * One source of truth for the shape — the persisted `pr.checks` schema — plus
 * the drift count it carries through its loose extra keys.
 *
 * `unknown` is the count of check runs GitHub REPORTED but Viberr could not
 * read: an entry that did not decode, a conclusion outside the known
 * vocabulary, or the shortfall between `total_count` and the entries the
 * payload actually carried. It exists because the alternative is a lie —
 * uncounted runs used to leave `passing: 0, failing: 0, pending: 0` against a
 * non-zero total, which `mapPrChecks` read as "everything passed". The key is
 * OMITTED when nothing drifted, so a healthy summary is byte-identical to the
 * one this module always wrote.
 */
export interface PrChecksSummary extends PrChecks {
  unknown?: number;
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
  /** Check-runs summary for the head sha. `null` = NOT READ (no head sha, or
   * the check-runs call failed) — UNKNOWN, so callers keep the cached value.
   * A repo with no CI reads as `{ total: 0, … }`, which is a real answer; runs
   * that were reported but not readable are counted in `unknown`, never left to
   * pass as green (F21-7). */
  checks: PrChecksSummary | null;
  /** Ruling 360 (pass 38, F38-14): the check-runs read for this head was
   *  ATTEMPTED and GitHub refused or failed it, so `checks` is null for THAT
   *  reason. Absent when the read succeeded or was never attempted (no head).
   *  A 403 here is the credential: a fine-grained token without Checks: read
   *  answers every check-runs read with it, and this instance merged 89
   *  red-CI heads with nothing said on the dialog that authorizes a merge. */
  checksUnread?: { status: number | null; message: string };
  /** P13-D-28: GitHub review state. The key is ABSENT when the reviews were not
   * read this pass (terminal PR, or the call failed) — UNKNOWN, so callers keep
   * the cached value; `null` means read-and-nothing-outstanding. */
  review?: PrReviewState | null;
  /** R19-B: the standing approvals with the commit each was submitted on.
   *  ABSENT under exactly the same rule as `review` — not read this pass
   *  (terminal PR, or the call failed) means UNKNOWN, so callers keep the
   *  cached value instead of erasing a real approval on a GitHub hiccup. */
  approvals?: PrApproval[];
  /** Ruling 484: the submitted reviews, for the relay. ABSENT under the same
   *  rule as `approvals`: not read this pass. */
  reviewEvents?: PrReviewEvent[];
  /** P14-LV-07: can GitHub merge this PR? ABSENT when the detail fetch failed
   * (unknown → callers keep the cached value) or the PR is terminal. */
  mergeable?: PrMergeable;
  /** Ruling 236: the paths this PR changes, pinned to the head they were read
   *  at. ABSENT under the same rule as everything above — not read this pass,
   *  so the caller keeps its cached list. Deliberately NOT fetched when the
   *  known head already matches: a file list cannot change without the head
   *  moving, so the common tick costs no extra call. */
  paths?: { headSha: string; changed: string[]; truncated: boolean };
}

export type PrLinkResult =
  | { status: "found"; pr: PrFacts }
  | { status: "none" }
  | { status: "forbidden"; message: string }
  | { status: "auth_failed"; message: string }
  | { status: "network_unavailable"; message: string };

/** A pulls LIST item's read slice. The identity fields are on every PR payload;
 *  the rest carry their readers' optional-chain tolerance (`undefined` on
 *  drift, never a voided response).
 *
 *  `number` and `state` stay STRICT on purpose. A PR with no number is not a PR
 *  the task can record, and `state` decides the cache vocabulary — an absent one
 *  would map to "review" (`mapPrToCacheState`'s open default) and claim a closed
 *  PR is open, which is the silent UPGRADE this layer must never produce. Both
 *  now fail as a typed `decode` result (never a throw), and the caller keeps its
 *  cached PR facts rather than replacing them with a guess. `title` is
 *  recoverable — an empty one costs a label, nothing else. */
const ghPullListItemSchema = z.object({
  number: z.number(),
  title: z.string().catch(""),
  state: z.string(),
  draft: z.boolean().optional().catch(undefined),
  merged_at: z.string().nullable().optional().catch(undefined),
  head: z
    .object({ sha: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

const ghPullDetailSchema = ghPullListItemSchema.extend({
  /** The list item (which always carries the title) is the primary read; a
   *  detail payload without one must not void the whole link, so it degrades
   *  to an empty title instead. */
  title: z.string().catch(""),
  merged: z.boolean().optional().catch(undefined),
  additions: z.number().optional().catch(undefined),
  deletions: z.number().optional().catch(undefined),
  changed_files: z.number().optional().catch(undefined),
  /** P14-LV-07: `null` while GitHub computes it (first read after a push), then
   *  true/false. `mergeable_state` carries the WHY ("dirty" = conflicts). */
  mergeable: z.boolean().nullable().optional().catch(undefined),
  mergeable_state: z.string().optional().catch(undefined),
  /** P13-D-28: who has been ASKED to review (free — the detail fetch already
   *  happens). Distinguishes "review required" from "nobody is expected". Only
   *  the lengths are read, so the entries stay unmodeled. */
  requested_reviewers: z.array(z.unknown()).optional().catch(undefined),
  requested_teams: z.array(z.unknown()).optional().catch(undefined),
});
type GhPullDetail = z.output<typeof ghPullDetailSchema>;

/** ONE check run's read slice — only `conclusion` is consumed. `null` means
 *  "still running", which is a real answer; anything else is drift, and drift
 *  is COUNTED (see {@link summarizeCheckRuns}), never quietly skipped. */
const ghCheckRunSchema = z.object({
  conclusion: z.string().nullable().optional(),
});

/** The check-runs payload's read slice. An entry that does not decode becomes
 *  `null` — kept DISTINCT from a run GitHub sent without a conclusion, so the
 *  accounting can never mistake one for a real answer — and, above all, it does
 *  not void the array: one bad entry used to discard every readable sibling
 *  alongside it. */
const ghCheckRunsSchema = z
  .object({
    total_count: z.number().optional().catch(undefined),
    check_runs: z
      .array(ghCheckRunSchema.nullable().catch(null))
      .optional()
      .catch(undefined),
  })
  .catch({});

/** One entry of `GET /pulls/{n}/reviews` — an EVENT log, not a per-reviewer
 *  state: the same person appears once per submitted review. */
export interface GhReview {
  state?: string;
  user?: { login?: string } | null;
  /** R19-B: the commit the review was submitted ON. This is what binds a human
   *  approval to a revision — GitHub keeps an approval standing after new
   *  commits land, so without it "approved" says nothing about WHAT was
   *  approved. */
  commit_id?: string | null;
  submitted_at?: string | null;
  /** Ruling 484: the review's id (what its line comments are listed under,
   *  and what the relay records once it has relayed it) and its body. */
  id?: number;
  body?: string | null;
}

/** {@link GhReview}, as parsed at the boundary. Every field already tolerates
 *  absence in the derivations, so each parses to `undefined` on drift; a
 *  non-object entry becomes `{}` and a non-array payload `[]` — the same
 *  nothing the raw reads made of them. */
const ghReviewsSchema = z
  .array(
    z
      .object({
        state: z.string().optional().catch(undefined),
        user: z
          .object({ login: z.string().optional().catch(undefined) })
          .nullable()
          .optional()
          .catch(undefined),
        commit_id: z.string().nullable().optional().catch(undefined),
        submitted_at: z.string().nullable().optional().catch(undefined),
        id: z.number().int().optional().catch(undefined),
        body: z.string().nullable().optional().catch(undefined),
      })
      .catch({}),
  )
  .catch([]);

/**
 * Ruling 484 (pass 40, F40-54): one SUBMITTED review, as the reconciler's
 * review relay reads it. A CHANGES_REQUESTED review used to become a pill
 * state and nothing else; its body and its line comments never reached the
 * agent that delivered the work.
 */
export interface PrReviewEvent {
  id: number;
  /** GitHub login of the reviewer (mapped to a member by the relay). */
  login: string;
  /** Upper-cased: APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED. */
  state: string;
  /** The commit the review was submitted on. */
  commitSha: string | null;
  body: string;
  at: string | null;
}

/** The submitted reviews off the SAME `/reviews` payload the pill reads. A
 *  PENDING review is the reviewer's unsent draft, and an entry with no id or
 *  no login cannot be listed or attributed, so none of those is kept. */
export function reviewEventsOf(reviews: readonly GhReview[]): PrReviewEvent[] {
  const events: PrReviewEvent[] = [];
  for (const review of reviews) {
    const state = (review.state ?? "").toUpperCase();
    const login = review.user?.login;
    if (state === "" || state === "PENDING" || !login || review.id === undefined) continue;
    events.push({
      id: review.id,
      login,
      state,
      commitSha: review.commit_id ?? null,
      body: review.body ?? "",
      at: review.submitted_at ?? null,
    });
  }
  return events;
}

/** R19-B — a reviewer whose LATEST review is an approval, and the commit it
 *  was submitted on. */
export interface PrApproval {
  /** GitHub login of the approver (never a Viberr identity — mapping happens
   *  in the reconciler, against the project's members). */
  login: string;
  /** The commit the approval was submitted on; null when GitHub omitted it. */
  commitSha: string | null;
  /** ISO timestamp of the approval, or null. */
  at: string | null;
}

/**
 * The change stats on a PR detail payload. GitHub sends all three or the read
 * is not a detail read — parsed here rather than probed field by field, so the
 * "did we get numbers?" question is answered once, at the boundary.
 */
const prChangeStatsSchema = z.object({
  additions: z.number(),
  deletions: z.number(),
  changed_files: z.number(),
});

const PASSING = new Set(["success", "neutral", "skipped"]);
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/** One decoded check-run entry, or `null` for an entry that did not decode. */
type GhCheckRun = z.output<typeof ghCheckRunSchema> | null;

/**
 * F21-7 — the check-runs rollup, where every run GitHub reported is accounted
 * for by exactly one counter.
 *
 * The old rollup counted `passing` and `failing` off the entries it could read
 * and took `total` from `total_count`, so anything it could NOT read simply
 * vanished from the three counters while still inflating the total. A payload
 * like `{ total_count: 3, check_runs: [null, "x"] }` summed to
 * `{ total: 3, passing: 0, failing: 0, pending: 0 }` — which the pill mapper
 * reads as "3 checks passing" and the reconciler then persists into task.md.
 * Drift is not a green build.
 *
 * So: `null` conclusion = pending (still running, a real answer); a conclusion
 * in the known vocabularies = passing/failing; an undecodable entry, an ABSENT
 * conclusion, an unrecognized one (GitHub's `stale`) and the shortfall against
 * `total_count` all land in `unknown`. `total` is never below what was counted.
 *
 * Exported for direct unit coverage of the accounting.
 */
export function summarizeCheckRuns(input: {
  totalCount: number | undefined;
  runs: readonly GhCheckRun[] | undefined;
}): PrChecksSummary {
  let passing = 0;
  let failing = 0;
  let pending = 0;
  let unknown = 0;
  for (const run of input.runs ?? []) {
    const conclusion = run?.conclusion;
    if (conclusion === null) pending += 1;
    else if (conclusion === undefined) unknown += 1;
    else if (PASSING.has(conclusion)) passing += 1;
    else if (FAILING.has(conclusion)) failing += 1;
    else unknown += 1;
  }
  const counted = passing + failing + pending + unknown;
  // A `total_count` BELOW the entries carried is itself drift; the entries are
  // the floor, so the counters can never exceed the total they are read against.
  const total = Math.max(input.totalCount ?? counted, counted);
  const unaccounted = total - counted;
  const summary: PrChecksSummary = { total, passing, failing, pending };
  if (unknown + unaccounted > 0) summary.unknown = unknown + unaccounted;
  return summary;
}

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
 * R19-B — the reviewers whose CURRENT state is APPROVED, with the commit each
 * one approved.
 *
 * Same event-log reduction as {@link deriveReviewState} (latest entry per
 * reviewer wins; `COMMENTED`/`PENDING` are not verdicts and never replace a
 * standing one; `DISMISSED` withdraws it) — deliberately derived from the SAME
 * already-fetched `/reviews` payload rather than a second call. The difference
 * is that this keeps the identity and the commit, which is what lets a human
 * approval be bound to the delivered revision the way an agent verdict is.
 *
 * A reviewer with an outstanding CHANGES_REQUESTED is not listed, by
 * construction: their latest state is not APPROVED.
 */
export function deriveApprovals(reviews: readonly GhReview[]): PrApproval[] {
  const latest = new Map<string, PrApproval & { state: string }>();
  for (const review of reviews) {
    const state = (review.state ?? "").toUpperCase();
    if (state === "COMMENTED" || state === "PENDING" || state === "") continue;
    const login = review.user?.login;
    if (!login) continue;
    latest.set(login, {
      state,
      login,
      commitSha: review.commit_id ?? null,
      at: review.submitted_at ?? null,
    });
  }
  return [...latest.values()]
    .filter((r) => r.state === "APPROVED")
    .map(({ login, commitSha, at }) => ({ login, commitSha, at }));
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
/** Ruling 236: the one field the changed-files read uses. A row without a
 *  usable `filename` is dropped rather than failing the page, and a page that
 *  does not parse at all leaves the key absent (= not read). */
const ghPullFileSchema = z.object({ filename: z.string().min(1) }).loose();

/**
 * Ruling 236 — the repository paths a pull request changes.
 *
 * Called only when the head MOVED (see `knownPathsHeadSha`), because a file
 * list cannot change without it: on a board where most ticks find nothing new,
 * this adds no API traffic at all. Capped at `PR_PATHS_MAX` with `truncated`
 * set, and the cap is honest rather than silent — an overlap computed from a
 * clipped list can only miss a collision, never invent one.
 *
 * Returns undefined when the read failed, which is the caller's "not read this
 * pass" and makes it keep whatever it had.
 */
async function readPrPaths(
  client: GithubClient,
  repo: string,
  number: number,
  headSha: string,
): Promise<PrFacts["paths"] | undefined> {
  const perPage = 100;
  const changed: string[] = [];
  let truncated = false;
  for (let page = 1; changed.length < PR_PATHS_MAX; page++) {
    const answer = await client.request(
      "GET",
      `/repos/${repo}/pulls/${number}/files`,
      z.array(ghPullFileSchema),
      { searchParams: { per_page: perPage, page } },
    );
    if (!answer.ok) return undefined; // not read: the caller keeps its cache
    for (const row of answer.data) {
      if (changed.length >= PR_PATHS_MAX) {
        truncated = true;
        break;
      }
      changed.push(row.filename);
    }
    if (answer.data.length < perPage) break;
    if (changed.length >= PR_PATHS_MAX) {
      truncated = true;
      break;
    }
  }
  return { headSha, changed, truncated };
}

export async function findPrForBranch(
  client: GithubClient,
  repo: string,
  branch: string,
  /** Ruling 236: the head the caller's cached `pr.paths` was read at. When the
   *  live head still equals it the changed-file read is SKIPPED and the key is
   *  left absent, so the caller keeps the list it already has. */
  knownPathsHeadSha?: string | null,
): Promise<PrLinkResult> {
  const owner = repo.split("/")[0] ?? repo;
  const list = await client.request(
    "GET",
    `/repos/${repo}/pulls`,
    z.array(ghPullListItemSchema),
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
    // Everything else — including a payload that did not decode — degrades to
    // "we could not read GitHub", carrying the reason instead of "unknown".
    return { status: "network_unavailable", message: githubFailureMessage(list) };
  }
  const head = list.data[0];
  if (!head) return { status: "none" };

  // Detail fetch for merged flag + change stats (list items omit them).
  const detail = await client.request(
    "GET",
    `/repos/${repo}/pulls/${head.number}`,
    ghPullDetailSchema,
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
    const branchRes = await client.request(
      "GET",
      `/repos/${repo}/branches/${encodeURIComponent(branch)}`,
      z
        .object({
          commit: z
            .object({ sha: z.string().optional().catch(undefined) })
            .optional()
            .catch(undefined),
        })
        .catch({}),
    );
    if (branchRes.ok) {
      const branchHead = branchRes.data.commit?.sha ?? null;
      if (branchHead && branchHead !== headSha) {
        return { status: "none" };
      }
    }
  }

  let checks: PrChecksSummary | null = null;
  let checksUnread: { status: number | null; message: string } | null = null;
  if (headSha) {
    const checkRuns = await client.request(
      "GET",
      `/repos/${repo}/commits/${headSha}/check-runs`,
      ghCheckRunsSchema,
      { searchParams: { per_page: 100 } },
    );
    if (checkRuns.ok) {
      checks = summarizeCheckRuns({
        totalCount: checkRuns.data.total_count,
        runs: checkRuns.data.check_runs,
      });
      // The DIAGNOSTIC half of the tolerant-parsing rule: the summary degrades
      // the pill on its own, and this names the payload that caused it.
      if (checks.unknown) {
        logger.warn("check-runs payload partly unreadable — CI reads unknown", {
          repo,
          headSha,
          total: checks.total,
          unknown: checks.unknown,
        });
      }
    } else if (checkRuns.kind === "network") {
      checksUnread = { status: null, message: checkRuns.message };
    } else if (checkRuns.kind !== "not_modified") {
      // Ruling 360: the refusal is carried, not swallowed — it used to leave
      // `checks: null` indistinguishable from "never looked".
      checksUnread = { status: checkRuns.status, message: checkRuns.message };
    }
  }

  // P13-D-28: review-state awareness (prd.md:124) — ONE extra GET, on the same
  // client/timeout/error plumbing, and only for a PR that is still OPEN. A
  // merged/closed PR's review state is settled history, so paying an API call
  // for it on every 5-minute reconcile pass would be exactly the waste this
  // finding was filed about. A failed read leaves `review` ABSENT (unknown) so
  // the caller keeps the cached value instead of blanking the pill.
  let review: PrReviewState | null | undefined;
  let approvals: PrApproval[] | undefined;
  let reviewEvents: PrReviewEvent[] | undefined;
  if (state === "review") {
    const reviews = await client.request(
      "GET",
      `/repos/${repo}/pulls/${head.number}/reviews`,
      ghReviewsSchema,
      { searchParams: { per_page: 100 } },
    );
    if (reviews.ok) {
      const entries = reviews.data;
      review = deriveReviewState(
        entries,
        (pr.requested_reviewers?.length ?? 0) + (pr.requested_teams?.length ?? 0),
      );
      // R19-B: same payload, no extra call — the identities + commits behind
      // the pill, so a project member's approval can BE the verdict.
      approvals = deriveApprovals(entries);
      // Ruling 484: and the reviews themselves, for the relay. Same payload.
      reviewEvents = reviewEventsOf(entries);
    }
  }

  // The change stats are read as ONE fact off the detail payload: the list item
  // carries none of the three, and a partial answer ("+12 lines over an unknown
  // number of files") is not a change summary. A payload that does not parse
  // leaves `changed` null — the caller's "not read" value.
  const stats = detail.ok ? prChangeStatsSchema.safeParse(pr) : null;
  const facts: PrFacts = {
    number: pr.number,
    title: pr.title,
    state,
    draft: pr.draft ?? false,
    headSha,
    changed: stats?.success
      ? {
          files: stats.data.changed_files,
          add: stats.data.additions,
          del: stats.data.deletions,
        }
      : null,
    checks,
  };
  if (checksUnread) facts.checksUnread = checksUnread;
  // `review` and `approvals` are set only when the reviews call actually ran —
  // an ABSENT key means "not read this pass", which is what makes the caller
  // keep its cached value instead of erasing it.
  if (review !== undefined) facts.review = review;
  if (approvals !== undefined) facts.approvals = approvals;
  if (reviewEvents !== undefined) facts.reviewEvents = reviewEvents;
  // P14-LV-07: only an OPEN PR has a meaningful mergeability, and only the
  // detail fetch carries it. A failed detail read — or GitHub still
  // COMPUTING the answer (the first read after a push) — leaves the key
  // absent, so the caller keeps the last-known value instead of flapping
  // the pill through "unknown" on every push.
  const mergeable =
    detail.ok && state === "review" ? deriveMergeable(pr) : "unknown";
  if (mergeable !== "unknown") facts.mergeable = mergeable;
  // Ruling 236: only an OPEN pull request's file list is worth anything to the
  // overlap read, and only a head that MOVED can have changed it.
  if (state === "review" && headSha && headSha !== knownPathsHeadSha) {
    const paths = await readPrPaths(client, repo, pr.number, headSha);
    if (paths) facts.paths = paths;
  }
  return { status: "found", pr: facts };
}

/**
 * Ruling 160 (pass 35, F35-11): the SAME pull request the task already
 * references, read by NUMBER.
 *
 * `findPrForBranch` lists by head branch and, for a closed PR whose branch has
 * since advanced, answers `none` (F26): right for a stranger's stale PR on a
 * reused branch name, blind for the task's OWN PR when a push landed after a
 * person closed it. Live (KNC-23) the operator's base refresh moved the branch
 * eleven seconds after the owner closed PR #10, the reconcile that followed
 * found nothing under the branch name, and the cache went on saying `review`.
 * This read exists for that gap: a settled fact about the task's own number is
 * this task's news whatever the branch listing says. Only a TERMINAL answer is
 * worth adopting (an open PR the listing missed keeps `none`, unchanged), and a
 * degraded read is `none` too: the caller keeps its cached facts and the next
 * pass asks again. Change stats and checks are not read (a settled PR's pills
 * are dropped by the caller anyway).
 */
export async function readTerminalPrByNumber(
  client: GithubClient,
  repo: string,
  number: number,
): Promise<{ status: "found"; pr: PrFacts } | { status: "none" }> {
  const detail = await client.request(
    "GET",
    `/repos/${repo}/pulls/${number}`,
    ghPullDetailSchema,
  );
  if (!detail.ok) return { status: "none" };
  const state = mapPrToCacheState(detail.data);
  if (state !== "closed" && state !== "merged") return { status: "none" };
  return {
    status: "found",
    pr: {
      number: detail.data.number,
      title: detail.data.title,
      state,
      draft: detail.data.draft ?? false,
      headSha: detail.data.head?.sha ?? null,
      changed: null,
      checks: null,
    },
  };
}

/** The issue payload's read slice: pull requests are issues on GitHub, and the
 *  ISSUE endpoint is the one that names who closed one (`closed_by`); the pulls
 *  endpoint never does. Tolerant end to end: this read only ever names a
 *  person, so drift costs the name and nothing else. */
const ghIssueCloserSchema = z
  .object({
    closed_by: z
      .object({ login: z.string().optional().catch(undefined) })
      .nullable()
      .optional()
      .catch(undefined),
  })
  .catch({});

/**
 * Ruling 160: the GitHub login of whoever closed the pull request, or null
 * when GitHub named nobody (a degraded read, a closure GitHub attributes to no
 * account). One call, on the transition into `closed` only.
 */
export async function readPrCloser(
  client: GithubClient,
  repo: string,
  number: number,
): Promise<string | null> {
  const issue = await client.request(
    "GET",
    `/repos/${repo}/issues/${number}`,
    ghIssueCloserSchema,
  );
  if (!issue.ok) return null;
  return issue.data.closed_by?.login ?? null;
}
