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
  // The canonical sentence rides along verbatim, so the permanent record and
  // every live surface can be matched word for word.
  if (described.kind === "base_refresh" && refresh) {
    return ` The PR head (${head}) carries a base refresh made after the review (${plural(refresh.merges, "merge commit")}, ${plural(refresh.commits, "base commit")}) and no authored commits outside the reviewed revision: ${described.sentence}.`;
  }
  const authored = `${drift.authored === 1 ? "1 authored commit was" : `${drift.authored} authored commits were`} added to the PR head (${head}) after the review, outside the reviewed revision`;
  if (described.kind === "both" && refresh) {
    return ` ${authored}; the head also carries a base refresh (${plural(refresh.merges, "merge commit")}, ${plural(refresh.commits, "base commit")}): ${described.sentence}.`;
  }
  return ` ${authored}: ${described.sentence}.`;
}

/** One commit of a GitHub compare, as the drift classifier reads it. */
export interface DriftCommit {
  fullSha: string;
  parents: readonly string[];
}

/** The slice of a compare the classifier needs: the counter GitHub sent, the
 *  commits it listed, and how many entries the reader could not decode. */
export interface DriftCompareSlice {
  aheadBy: number;
  commits: readonly DriftCommit[];
  droppedCommits: number;
}

export interface ClassifyDriftInput {
  headSha: string;
  /** `reviewedSha...head`: every commit reachable from the head, not from the reviewed revision. */
  since: DriftCompareSlice;
  /** `base...branch` against the project's default branch: the branch's OWN commits. Null when it could not be read. */
  base: DriftCompareSlice | null;
  /** The merge commits `update_branch_from_base` made and recorded in `baseRefreshes[]`. */
  recordedMergeShas: ReadonlySet<string>;
}

/**
 * Ruling 132 (pass 34, F34-14): classify the commits since the reviewed
 * revision. A commit not among the branch's own commits (it is reachable from
 * the base) is a base commit; a two-parent commit Viberr itself recorded in
 * `baseRefreshes` is a clean merge; anything else is AUTHORED, including a
 * merge Viberr did not make. Fail-closed: the answer is null (unclassifiable)
 * unless BOTH compares are complete (nothing dropped, every counted commit
 * listed) and the base compare was read at all; the caller then carries the
 * last measurement or records every commit as authored, never "no drift".
 * The base compare is against the project's default branch, the only base
 * Viberr delivers to; a PR retargeted elsewhere is unclassifiable by design.
 */
export function classifyRevisionDrift(input: ClassifyDriftInput): RevisionDrift | null {
  const { since, base } = input;
  const complete = (slice: DriftCompareSlice) =>
    slice.droppedCommits === 0 && slice.commits.length >= slice.aheadBy;
  if (!base || !complete(since) || !complete(base)) return null;
  const branchOwn = new Set(base.commits.map((c) => c.fullSha));
  let authored = 0;
  let merges = 0;
  let commits = 0;
  for (const commit of since.commits) {
    if (!branchOwn.has(commit.fullSha)) {
      commits += 1;
    } else if (commit.parents.length >= 2 && input.recordedMergeShas.has(commit.fullSha)) {
      merges += 1;
    } else {
      authored += 1;
    }
  }
  return {
    headSha: input.headSha,
    authored,
    baseRefresh: merges > 0 || commits > 0 ? { merges, commits } : null,
  };
}

/** One recorded base refresh as the chain reads it (`baseRefreshes[]`). */
export interface RefreshLink {
  /** The merge commit the refresh made. */
  mergeSha: string;
  /** The branch head it merged the base onto. A record without it links
   *  nothing. */
  onto?: string | undefined;
  /** How many base commits it brought in. */
  commits: number;
}

/** Where a head leads through Viberr's own base refreshes (ruling 439). */
export interface RefreshChain {
  /** Each refresh merge the chain reaches, oldest first, with the base
   *  commits it brought in. The last one is where the chain ends. */
  links: { head: string; commits: number }[];
}

/**
 * Ruling 439 (pass 39, F39-62): the heads a revision reaches through Viberr's
 * own base refreshes alone.
 *
 * `update_branch_from_base` merges the base onto the branch head with
 * `--no-ff` and records the head it merged onto (`onto`). A refresh made onto
 * the revision's head, then one made onto THAT merge, and so on, carries the
 * revision's deliverable on a newer base and nothing else, which is ruling
 * 238's premise that a refresh does not change what was delivered. A refresh
 * made onto any other commit sits on authored work nobody has reviewed, so it
 * is not on the chain.
 *
 * Null when no recorded refresh was made onto `headSha`.
 */
export function refreshChainFrom(
  headSha: string,
  refreshes: readonly RefreshLink[],
): RefreshChain | null {
  const links: RefreshChain["links"] = [];
  // Each record is followed at most once, so a malformed list cannot loop.
  const unused = [...refreshes];
  let at = headSha;
  for (;;) {
    const i = unused.findIndex((r) => r.onto === at);
    const link = unused[i];
    if (i < 0 || !link) break;
    unused.splice(i, 1);
    links.push({ head: link.mergeSha, commits: link.commits });
    at = link.mergeSha;
  }
  return links.length > 0 ? { links } : null;
}

/** Ruling 439: is `headSha` the revision's own head, or one it reaches through
 *  Viberr's base refreshes alone? */
export function headCarriesRevision(
  revisionHeadSha: string,
  headSha: string,
  refreshes: readonly RefreshLink[],
): boolean {
  if (headSha === revisionHeadSha) return true;
  return refreshChainFrom(revisionHeadSha, refreshes)?.links.some((l) => l.head === headSha) ?? false;
}

/** The commit a re-review should read, and why it is not always the reviewed
 *  one (ruling 238). Client-safe: every field is a fact already on the task. */
export interface ReviewSubject {
  /** The sha to check the reviewer's tree out at. */
  sha: string;
  /** Set only when {@link sha} is NOT the reviewed revision: the revision the
   *  verdict still binds to, and the refresh that moved the subject past it. */
  rePinned: {
    reviewedSha: string;
    baseRefresh: { merges: number; commits: number };
  } | null;
}

/**
 * Ruling 238 (pass 37, F37-58): which commit a re-review reads.
 *
 * Ruling 179 pins a supporting checkout at the revision under review, so a
 * reviewer judges what it was asked to judge and never a head that moved under
 * it. That is right whenever the head moved because someone AUTHORED something.
 *
 * It is wrong for a base refresh, and the case is not hypothetical. A reviewer
 * whose surface reaches outside the task's owned paths — any stack or
 * integration reviewer — can block on a defect in the BASE. Viberr's own
 * `update_branch` then merges the fixed base in, `classifyRevisionDrift` reads
 * `authored: 0` and `describeRevisionDrift` says the review still stands
 * (correctly: the deliverable's tree is untouched). But the pin puts the
 * re-review back on the pre-refresh base, where the defect is still there, so
 * it objects again — on SHOP-18 twice, and the only way out was an admin
 * force-accept over a gate that had wedged because the task did exactly what it
 * was asked to do.
 *
 * So the subject moves to the refreshed head when the drift is base-refresh
 * ONLY, and the disclosure says it did. One authored commit anywhere in the
 * drift keeps the pin: that is unreviewed work, and reading it unasked is the
 * failure ruling 179 exists to prevent.
 *
 * The drift must have been measured AT the head being offered — a measurement
 * against an older head says nothing about this one, and acting on it would
 * re-pin onto commits nobody has classified.
 */
export function reviewSubjectSha(input: {
  /** The reviewed revision's head — what ruling 179 pins to. */
  reviewedSha: string | null;
  /** The pull request's live head, or null when there is no PR. */
  prHeadSha: string | null;
  /** The drift the reconciler last measured. */
  drift: RevisionDrift | null | undefined;
  /** Ruling 439: the base refreshes Viberr recorded on the task. */
  refreshes: readonly RefreshLink[];
}): ReviewSubject | null {
  const { reviewedSha, prHeadSha, drift } = input;
  if (!reviewedSha) return null;
  const stand: ReviewSubject = { sha: reviewedSha, rePinned: null };
  if (prHeadSha === reviewedSha) return stand;
  if (prHeadSha && drift && drift.headSha === prHeadSha) {
    const refresh = drift.baseRefresh;
    if (drift.authored !== 0 || !refresh) return stand;
    if (refresh.merges === 0 && refresh.commits === 0) return stand;
    return { sha: prHeadSha, rePinned: { reviewedSha, baseRefresh: refresh } };
  }
  // Ruling 439 (pass 39, F39-62): with no measurement at the head being
  // offered, the refreshes Viberr itself recorded still say what a head is.
  // Live on ax-clone AX-29 the operator refreshed the branch onto the reviewed
  // revision and dispatched the reviewer before any PR existed, so there was
  // no drift to read and the reviewer was detached at the pre-refresh commit.
  // Its gates failed on exactly the four tests the merged base had fixed, and
  // it approved only because it noticed on its own that the branch had moved.
  // Without a PR the offered head is where the chain ends: the branch as
  // Viberr's last refresh pushed it. With one, only a PR head the chain
  // reaches is offered; anything else keeps the pin.
  const chain = refreshChainFrom(reviewedSha, input.refreshes);
  if (!chain) return stand;
  const upTo = prHeadSha
    ? chain.links.findIndex((l) => l.head === prHeadSha)
    : chain.links.length - 1;
  const reached = chain.links.slice(0, upTo + 1);
  const head = reached.at(-1)?.head;
  if (upTo < 0 || !head) return stand;
  return {
    sha: head,
    rePinned: {
      reviewedSha,
      baseRefresh: {
        merges: reached.length,
        commits: reached.reduce((n, l) => n + l.commits, 0),
      },
    },
  };
}
