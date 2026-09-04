/**
 * Revision drift — the ONE description of "what changed on the PR head after
 * the reviewed revision" (ruling 132, pass 34 F34-14). Client-safe.
 *
 * R17-1 measured drift as GitHub's `compare(reviewedSha...head).ahead_by`,
 * which counts every commit reachable from the head and not from the reviewed
 * revision — so an operator's `update_branch_from_base` (four commits from
 * `main` plus the merge commit) read as "5 commits added since review; they
 * merge unreviewed" on the accept dialog, the review-queue subline and the
 * permanent completion record, while the operator's own read said no drift.
 *
 * Drift is now the number of AUTHORED commits since the reviewed revision:
 * commits in `reviewedSha...head` that are not on the base branch and are not
 * clean merge commits Viberr itself made (recorded on the task as
 * `baseRefreshes[]`). A base refresh is reported separately and never as
 * unreviewed work. Every surface prints {@link describeRevisionDrift}'s
 * sentence verbatim; none re-derives the words from the counts.
 */

export interface RevisionDrift {
  /** The PR head this measurement describes (full sha). */
  headSha: string;
  /** Authored commits since the reviewed revision — the ones that ship
   *  unreviewed. A commit the reconciler could not classify counts here. */
  authored: number;
  /** A base refresh the head carries since the review: how many merge commits
   *  Viberr made (`0` for a fast-forward refresh) and how many base commits
   *  they brought in. Null when the head carries no base refresh. */
  baseRefresh: { merges: number; commits: number } | null;
}

export type RevisionDriftKind = "none" | "authored" | "base_refresh" | "both";

export interface RevisionDriftDescription {
  kind: RevisionDriftKind;
  /** The canonical sentence, empty for `none`. */
  sentence: string;
  /** True only when authored commits ship unreviewed. */
  unreviewed: boolean;
}

const plural = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

function baseRefreshClause(refresh: { merges: number; commits: number }): string {
  return `base refreshed · ${plural(refresh.merges, "merge commit")} · ${plural(refresh.commits, "base commit")}`;
}

/**
 * The sentence every surface prints for a drift record. Shapes:
 *
 *   none          → ""
 *   authored      → "1 authored commit since review merges unreviewed"
 *   base_refresh  → "base refreshed · 1 merge commit · 4 base commits ·
 *                    0 authored commits since review"
 *   both          → "2 authored commits since review merge unreviewed ·
 *                    base refreshed · 1 merge commit · 4 base commits"
 */
export function describeRevisionDrift(
  drift: RevisionDrift | null | undefined,
): RevisionDriftDescription {
  if (!drift) return { kind: "none", sentence: "", unreviewed: false };
  const authored = Math.max(0, drift.authored);
  const refresh =
    drift.baseRefresh && (drift.baseRefresh.merges > 0 || drift.baseRefresh.commits > 0)
      ? drift.baseRefresh
      : null;
  if (authored === 0 && !refresh) {
    return { kind: "none", sentence: "", unreviewed: false };
  }
  const authoredClause = `${plural(authored, "authored commit")} since review ${authored === 1 ? "merges" : "merge"} unreviewed`;
  if (authored > 0 && refresh) {
    return {
      kind: "both",
      sentence: `${authoredClause} · ${baseRefreshClause(refresh)}`,
      unreviewed: true,
    };
  }
  if (authored > 0) {
    return { kind: "authored", sentence: authoredClause, unreviewed: true };
  }
  return {
    kind: "base_refresh",
    sentence: `${baseRefreshClause(refresh!)} · 0 authored commits since review`,
    unreviewed: false,
  };
}

/**
 * The completion record's suffix: what a Done task's own timeline says about
 * the head it was accepted with. Empty when there is no drift. Kept beside the
 * sentence so the permanent record and the live surfaces share ONE vocabulary
 * (F19-23: the noun and the verb once disagreed on this exact sentence).
 */
export function revisionDriftNote(drift: RevisionDrift | null | undefined): string {
  const described = describeRevisionDrift(drift);
  if (described.kind === "none" || !drift) return "";
  const head = `\`${drift.headSha.slice(0, 12)}\``;
  const refresh = drift.baseRefresh;
  if (described.kind === "base_refresh" && refresh) {
    return ` The PR head (${head}) carries a base refresh made after the review (${plural(refresh.merges, "merge commit")}, ${plural(refresh.commits, "base commit")}) and no authored commits outside the reviewed revision.`;
  }
  const authored = `${drift.authored === 1 ? "1 authored commit was" : `${drift.authored} authored commits were`} added to the PR head (${head}) after the review, outside the reviewed revision`;
  if (described.kind === "both" && refresh) {
    return ` ${authored}; the head also carries a base refresh (${plural(refresh.merges, "merge commit")}, ${plural(refresh.commits, "base commit")}).`;
  }
  return ` ${authored}.`;
}
