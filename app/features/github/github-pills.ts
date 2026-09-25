import type { PillKind } from "~/ui/pill";
import type { RepoAccessResult } from "~/server/github/repo-access-check.server";

/**
 * Client-safe pill mappings for the GitHub view (github-view spec §4.3/§4.4,
 * ruling 12). `prStatePill` is the single PR-state → pill mapping (the old
 * server-side `prPillFor` duplicate was removed); the sync labels mirror
 * `branch-sync.server.ts` (`deriveSyncState`) — duplicated here only because
 * server modules must never reach client components; the shapes are covered by
 * tests on both sides.
 */

export interface PillView {
  kind: PillKind;
  label: string;
  /** The second pill tier (design pass 2026-09-08; `Pill`'s `quiet` prop): a
   *  FILL is a problem or a demand, an OUTLINE describes. The settled facts —
   *  merged, synced, approved, connected, every check passing — carry `quiet`
   *  here so every surface that renders them says so the same way; the
   *  states that want a person (closed, behind main, changes requested, a
   *  failing check, a missing credential) keep their fills. */
  quiet?: boolean;
}

/**
 * Sync column vocabulary (ruling 12: merged > behind > synced), plus `unknown`.
 *
 * UI-05: `unknown` exists because "we never measured this" is NOT "synced". The
 * behind-by resolver defaulted to 0 when no `github.reconcile` provenance row
 * existed, so every branch on a project that has never successfully reconciled
 * (no credential, repo not found, poller failing) showed the green "synced"
 * pill — flatly contradicting the page-level "Not synced yet" freshness chip,
 * and read by maintainers as "this branch is up to date with main".
 */
/**
 * Ruling 401 (F39-28): `no_branch` exists for the same reason `unknown` does,
 * one step further along.
 *
 * A task can finish without ever committing anything — a report, a design
 * note, an upstream comparison delivered as an attachment (ruling 391 settled
 * that such work is delivered work). Viberr allocates its branch NAME at
 * creation, so the row existed and carried whatever the last compare said.
 * Live on ax-clone AX-12 — done, `noChanges: true`, no PR, zero commits, and
 * no `ax-12` anywhere on the remote or in the mirror — that row read
 * "behind main" in a RISK fill: a demand, on finished work, for a branch that
 * does not exist and never will. It could not clear, because nothing about a
 * completed task moves again.
 */
export type SyncState =
  | "merged"
  | "behind_main"
  | "synced"
  | "unknown"
  | "no_branch";

const SYNC_PILL = {
  merged: { kind: "done", label: "merged", quiet: true },
  behind_main: { kind: "risk", label: "behind main" },
  synced: { kind: "ready", label: "synced", quiet: true },
  unknown: { kind: "neutral", label: "not compared" },
  no_branch: { kind: "neutral", label: "no branch", quiet: true },
} satisfies Record<SyncState, PillView>;

export function syncPill(state: SyncState): PillView {
  return SYNC_PILL[state] ?? SYNC_PILL.unknown;
}

/**
 * PR state pill (ruling 12): merged → done, closed-unmerged → risk "closed"
 * (the rendering the mock never designed), accepted (human accepted, real
 * merge pending — D3/S2) → amber "merge pending" matching the task-detail
 * branch panel, anything else ("review", open/draft) → info "in review".
 */
export function prStatePill(state: string): PillView {
  if (state === "merged") return { kind: "done", label: "merged", quiet: true };
  if (state === "closed") return { kind: "risk", label: "closed" };
  if (state === "accepted") return { kind: "input", label: "merge pending" };
  return { kind: "info", label: "in review" };
}

/**
 * CI health pill (P13-D-28). The check-runs summary had been fetched on every
 * reconcile pass since the PR linker was written and read by nothing — one API
 * call per pass spent for zero output. `failing > pending > unknown > passing`
 * matches the sync column's precedence: the worst true statement wins.
 *
 * A repo with no CI reports `total: 0`, and the mapper returns null for that
 * rather than a green "0 checks passing" — absence of CI is not a pass. Neither
 * is a check run nobody could read (F21-7): runs GitHub reported and Viberr
 * could not account for get their own grey pill, so the green one keeps meaning
 * "every run concluded well".
 */
/** Ruling 360: the read GitHub refused — neither green nor red, and never
 *  silence on a surface that would have shown the checks. */
export function checksUnreadPill(): PillView {
  return { kind: "neutral", label: "checks not readable" };
}

export function checksPill(checks: {
  total: number;
  passing: number;
  failing: number;
  pending: number;
  unknown?: number;
  state: "passing" | "failing" | "pending" | "unknown";
}): PillView {
  if (checks.state === "failing") {
    return { kind: "blocked", label: `${checks.failing}/${checks.total} checks failing` };
  }
  if (checks.state === "pending") {
    return { kind: "input", label: `${checks.pending}/${checks.total} checks running` };
  }
  if (checks.state === "unknown") {
    return {
      kind: "neutral",
      label: `${checks.unknown ?? checks.total}/${checks.total} checks unknown`,
    };
  }
  return { kind: "ready", label: `${checks.total} checks passing`, quiet: true };
}

/**
 * GitHub review-state pill (P13-D-28). Before this, a teammate approving or
 * requesting changes in GitHub's own UI changed nothing Viberr could see, so a
 * merge blocked by required reviews surfaced only as a late 405.
 *
 * `changes_requested` is `risk`, not `blocked` — it is a real signal but it is
 * GitHub's opinion, not this app's gate. In-product rejection (a reviewer's
 * `request_changes` verdict) is what actually blocks acceptance.
 */
export function reviewPill(
  review: "approved" | "changes_requested" | "review_required",
): PillView {
  if (review === "changes_requested") return { kind: "risk", label: "changes requested" };
  if (review === "approved") return { kind: "ready", label: "approved", quiet: true };
  return { kind: "input", label: "review required" };
}

/**
 * F17-L6: an open PR's mergeability. The task-detail acceptance chain already
 * names a conflicting PR ("conflicts with the base branch"); this surfaces the
 * SAME fact on the GitHub page's PR list + execution branches, where a human
 * decides whether a PR is safe to accept. Only "conflicting" earns a pill — a
 * clean or unknown state is the silent default, matching checks/review.
 */
export function mergeablePill(
  mergeable: "clean" | "conflicting" | "unknown" | null,
): PillView | null {
  return mergeable === "conflicting"
    ? { kind: "risk", label: "conflicts" }
    : null;
}

/**
 * Ruling 405: the verdict, but only while it still belongs to the live head.
 *
 * GitHub recomputes mergeability asynchronously, so the read right after a
 * push answers "unknown" and the reconciler keeps the last-known verdict for
 * the same PR — which is right when a READ failed and wrong when the head has
 * moved underneath it. `mergeableAt` is the head it was measured on.
 *
 * Lives here, in the client-safe module, because BOTH sides need it: the
 * server mapping (`mapPrMergeable`) that feeds the GitHub page and the review
 * queue, and the task page's own pill. Ruling 405(b) put it in the server
 * module first, which the task page could not import at all.
 */
export function liveMergeable(
  pr: {
    mergeable?: "clean" | "conflicting" | "unknown" | null;
    mergeableAt?: string | null;
    headSha?: string | null;
  } | null,
): "clean" | "conflicting" | "unknown" | null {
  if (!pr?.mergeable) return null;
  if (pr.mergeableAt && pr.headSha && pr.mergeableAt !== pr.headSha) return null;
  return pr.mergeable;
}

/**
 * Connection pill from the typed `checkRepoAccess` result (spec §7.9c: the
 * pill must not claim `connected` in any degraded state — no design exists
 * for these, so the labels below are the authored V1 vocabulary, documented
 * in the phase report).
 */
export function connectionPill(
  connection: Pick<RepoAccessResult, "status"> &
    Partial<Pick<Extract<RepoAccessResult, { status: "auth_failed" }>, "reason">>,
): PillView {
  switch (connection.status) {
    case "connected":
      return { kind: "ready", label: "connected", quiet: true };
    case "no_repo_configured":
      return { kind: "neutral", label: "no repository" };
    case "no_pat_configured":
      return { kind: "input", label: "no credential" };
    case "repo_not_found":
      return { kind: "risk", label: "repo not found" };
    case "auth_failed":
      return {
        kind: "blocked",
        label:
          connection.reason === "expired" ? "token expired" : "token revoked",
      };
    case "org_approval_missing":
      return { kind: "risk", label: "approval needed" };
    case "forbidden":
      return { kind: "risk", label: "access refused" };
    case "network_unavailable":
      return { kind: "neutral", label: "offline" };
    default:
      return { kind: "neutral", label: "unknown" };
  }
}

/**
 * Ruling 482 (F40-52): the project's gates as Viberr ran them on the revision
 * under review. A fill wherever the gates stand between the task and an
 * acceptance (failed, could not run, not run, out of date, still running); the
 * settled pass is an outline, like every passing check. One mapping for the PR
 * card and the accept dialog.
 */
export function gatesPill(
  state: "not_run" | "stale" | "queued" | "running" | "passed" | "failed" | "error",
): PillView {
  switch (state) {
    case "passed":
      return { kind: "ready", label: "gates passed", quiet: true };
    case "failed":
      return { kind: "blocked", label: "gates failed" };
    case "error":
      return { kind: "blocked", label: "gates could not run" };
    case "queued":
      return { kind: "input", label: "gates queued" };
    case "running":
      return { kind: "input", label: "gates running" };
    case "stale":
      return { kind: "risk", label: "gates out of date" };
    case "not_run":
      return { kind: "risk", label: "gates not run" };
  }
}
