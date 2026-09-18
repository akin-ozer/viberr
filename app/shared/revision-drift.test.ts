import { describe, expect, it } from "vitest";
import {
  describeRevisionDrift,
  revisionDriftNote,
  classifyRevisionDrift,
  reviewSubjectSha,
} from "./revision-drift";

const HEAD = "a4c790ce63ef0011223344556677889900aabbcc";

/**
 * Ruling 132 (pass 34, F34-14): ONE sentence for what moved on the PR head.
 * Only authored commits are "unreviewed"; a base refresh is named as one.
 *
 * Canary: derive the kind from `authored + (baseRefresh?.commits ?? 0)` (the
 * old `aheadBy` arithmetic) and the base-refresh shape reads 4 unreviewed
 * commits, which fails every assertion in that case.
 */
describe("describeRevisionDrift — the four shapes", () => {
  it("none: no record, or a record with nothing in it", () => {
    expect(describeRevisionDrift(null)).toEqual({ kind: "none", sentence: "", unreviewed: false });
    expect(describeRevisionDrift(undefined).kind).toBe("none");
    expect(
      describeRevisionDrift({ headSha: HEAD, authored: 0, baseRefresh: null }),
    ).toEqual({ kind: "none", sentence: "", unreviewed: false });
    // A zero-zero base refresh is nothing, not "base refreshed · 0 · 0".
    expect(
      describeRevisionDrift({ headSha: HEAD, authored: 0, baseRefresh: { merges: 0, commits: 0 } })
        .kind,
    ).toBe("none");
  });

  it("authored: the count, the verb agreeing, and UNREVIEWED", () => {
    expect(describeRevisionDrift({ headSha: HEAD, authored: 1, baseRefresh: null })).toEqual({
      kind: "authored",
      sentence: "1 authored commit since review merges unreviewed",
      unreviewed: true,
    });
    expect(describeRevisionDrift({ headSha: HEAD, authored: 3, baseRefresh: null })).toEqual({
      kind: "authored",
      sentence: "3 authored commits since review merge unreviewed",
      unreviewed: true,
    });
  });

  it("base_refresh: the JC-8 shape (one merge, four base commits) is NOT unreviewed work", () => {
    expect(
      describeRevisionDrift({ headSha: HEAD, authored: 0, baseRefresh: { merges: 1, commits: 4 } }),
    ).toEqual({
      kind: "base_refresh",
      sentence: "base refreshed · 1 merge commit · 4 base commits · 0 authored commits since review",
      unreviewed: false,
    });
    // A fast-forward refresh has zero merge commits and still reads as a refresh.
    expect(
      describeRevisionDrift({ headSha: HEAD, authored: 0, baseRefresh: { merges: 0, commits: 2 } })
        .sentence,
    ).toBe("base refreshed · 0 merge commits · 2 base commits · 0 authored commits since review");
  });

  it("both: authored first, the refresh named after it", () => {
    expect(
      describeRevisionDrift({ headSha: HEAD, authored: 2, baseRefresh: { merges: 1, commits: 4 } }),
    ).toEqual({
      kind: "both",
      sentence:
        "2 authored commits since review merge unreviewed · base refreshed · 1 merge commit · 4 base commits",
      unreviewed: true,
    });
  });
});

describe("revisionDriftNote — the completion record's suffix", () => {
  it("is empty for no drift", () => {
    expect(revisionDriftNote(null)).toBe("");
    expect(revisionDriftNote({ headSha: HEAD, authored: 0, baseRefresh: null })).toBe("");
  });

  it("names authored commits, with the verb agreeing (F19-23)", () => {
    // The canonical sentence rides along verbatim (ruling 132).
    expect(revisionDriftNote({ headSha: HEAD, authored: 1, baseRefresh: null })).toBe(
      " 1 authored commit was added to the PR head (`a4c790ce63ef`) after the review, outside the reviewed revision: 1 authored commit since review merges unreviewed.",
    );
    expect(revisionDriftNote({ headSha: HEAD, authored: 3, baseRefresh: null })).toContain(
      "3 authored commits were added",
    );
  });

  it("records a base refresh as a base refresh, never as added commits", () => {
    const note = revisionDriftNote({
      headSha: HEAD,
      authored: 0,
      baseRefresh: { merges: 1, commits: 4 },
    });
    expect(note).toContain("carries a base refresh made after the review");
    expect(note).toContain("1 merge commit, 4 base commits");
    expect(note).toContain("no authored commits");
    expect(note).toContain(describeRevisionDrift({ headSha: HEAD, authored: 0, baseRefresh: { merges: 1, commits: 4 } }).sentence);
    expect(note).not.toMatch(/\d+ commits were added/);
  });

  it("names both when both happened", () => {
    const note = revisionDriftNote({
      headSha: HEAD,
      authored: 2,
      baseRefresh: { merges: 1, commits: 4 },
    });
    expect(note).toContain("2 authored commits were added");
    expect(note).toContain("also carries a base refresh");
  });
});

/**
 * Ruling 132: the classifier. Base commits are the ones the branch's own
 * compare does not list; a two-parent commit Viberr recorded is a clean merge;
 * everything else is authored. Fail-closed on any incomplete compare. Canary:
 * drop the `notOnBase` membership test (every base commit reads as authored).
 */
describe("classifyRevisionDrift (ruling 132)", () => {
  const c = (fullSha: string, parents: string[] = ["p"]) => ({ fullSha, parents });
  const M = "m".repeat(40);
  const recorded = new Set([M]);
  it("a base refresh: authored 0, the merge and base commits reported apart", () => {
    const since = { aheadBy: 5, droppedCommits: 0, commits: [c("b1"), c("b2"), c("b3"), c("b4"), c(M, ["a0", "b4"])] };
    const base = { aheadBy: 2, droppedCommits: 0, commits: [c("a0"), c(M, ["a0", "b4"])] };
    expect(classifyRevisionDrift({ headSha: M, since, base, recordedMergeShas: recorded })).toEqual({
      headSha: M,
      authored: 0,
      baseRefresh: { merges: 1, commits: 4 },
    });
  });
  it("an authored commit on top of a refresh counts; a merge Viberr did not make counts as authored", () => {
    const since = { aheadBy: 3, droppedCommits: 0, commits: [c("b1"), c(M, ["a0", "b1"]), c("a2")] };
    const base = { aheadBy: 3, droppedCommits: 0, commits: [c("a0"), c(M, ["a0", "b1"]), c("a2")] };
    expect(classifyRevisionDrift({ headSha: "a2", since, base, recordedMergeShas: recorded })).toEqual({
      headSha: "a2",
      authored: 1,
      baseRefresh: { merges: 1, commits: 1 },
    });
    const foreign = { aheadBy: 2, droppedCommits: 0, commits: [c("b1"), c("x", ["a0", "b1"])] };
    const baseF = { aheadBy: 2, droppedCommits: 0, commits: [c("a0"), c("x", ["a0", "b1"])] };
    expect(classifyRevisionDrift({ headSha: "x", since: foreign, base: baseF, recordedMergeShas: recorded })).toEqual({
      headSha: "x",
      authored: 1,
      baseRefresh: { merges: 0, commits: 1 },
    });
  });
  it("a fast-forward refresh records {merges: 0, commits: N}", () => {
    const since = { aheadBy: 2, droppedCommits: 0, commits: [c("b1"), c("b2")] };
    const base = { aheadBy: 0, droppedCommits: 0, commits: [] };
    expect(classifyRevisionDrift({ headSha: "b2", since, base, recordedMergeShas: recorded })).toEqual({
      headSha: "b2",
      authored: 0,
      baseRefresh: { merges: 0, commits: 2 },
    });
  });
  it("fails closed: a missing, truncated or partly undecodable compare is unclassifiable", () => {
    const since = { aheadBy: 2, droppedCommits: 0, commits: [c("b1"), c("b2")] };
    const base = { aheadBy: 0, droppedCommits: 0, commits: [] };
    expect(classifyRevisionDrift({ headSha: "h", since, base: null, recordedMergeShas: recorded })).toBeNull();
    expect(classifyRevisionDrift({ headSha: "h", since: { ...since, droppedCommits: 1 }, base, recordedMergeShas: recorded })).toBeNull();
    expect(classifyRevisionDrift({ headSha: "h", since: { ...since, aheadBy: 3 }, base, recordedMergeShas: recorded })).toBeNull();
    expect(classifyRevisionDrift({ headSha: "h", since, base: { ...base, droppedCommits: 1 }, recordedMergeShas: recorded })).toBeNull();
  });
});

/**
 * Ruling 238 (pass 37, F37-58): which commit a re-review reads. The pin is
 * ruling 179's and stays, with exactly one exception — a head that moved only
 * because Viberr refreshed the base. Live on SHOP-18 the missing exception cost
 * an admin force-accept: the verifier's two blockers were fixed on `main` and
 * merged in, and the pin put every re-review back on the base that still had
 * them.
 */
describe("reviewSubjectSha (ruling 238)", () => {
  const REVIEWED = "b7c4c907eff3001122334455667788990011aabb";
  const REFRESHED = "aaf5e38b45f5001122334455667788990011ccdd";
  const baseOnly = {
    headSha: REFRESHED,
    authored: 0,
    baseRefresh: { merges: 1, commits: 20 },
  };

  it("moves the subject to the refreshed head, and says which revision the verdict still binds to", () => {
    // CANARY: return `stand` unconditionally and this is the live SHOP-18
    // state — the reviewer re-reads the base it already objected to.
    const subject = reviewSubjectSha({
      reviewedSha: REVIEWED,
      prHeadSha: REFRESHED,
      drift: baseOnly,
    });
    expect(subject).toEqual({
      sha: REFRESHED,
      rePinned: { reviewedSha: REVIEWED, baseRefresh: { merges: 1, commits: 20 } },
    });
  });

  it("keeps the pin the moment ANY authored commit is in the drift", () => {
    // One authored commit is unreviewed work, and reading it unasked is the
    // failure ruling 179 exists to prevent. CANARY: test `baseRefresh` without
    // also testing `authored === 0`.
    for (const drift of [
      { ...baseOnly, authored: 1 },
      { ...baseOnly, authored: 3, baseRefresh: { merges: 2, commits: 9 } },
    ]) {
      expect(
        reviewSubjectSha({ reviewedSha: REVIEWED, prHeadSha: REFRESHED, drift }),
      ).toEqual({ sha: REVIEWED, rePinned: null });
    }
  });

  it("keeps the pin when the drift was measured against a DIFFERENT head", () => {
    // A measurement against an older head classifies none of the commits on
    // this one. CANARY: drop the `drift.headSha !== prHeadSha` guard and a
    // stale base-refresh reading re-pins onto commits nobody has read.
    const stale = { ...baseOnly, headSha: "c".repeat(40) };
    expect(
      reviewSubjectSha({ reviewedSha: REVIEWED, prHeadSha: REFRESHED, drift: stale }),
    ).toEqual({ sha: REVIEWED, rePinned: null });
  });

  it("keeps the pin with no PR, no drift, an empty refresh, or a head that never moved", () => {
    const stands = { sha: REVIEWED, rePinned: null };
    expect(reviewSubjectSha({ reviewedSha: REVIEWED, prHeadSha: null, drift: baseOnly })).toEqual(stands);
    expect(reviewSubjectSha({ reviewedSha: REVIEWED, prHeadSha: REFRESHED, drift: null })).toEqual(stands);
    expect(
      reviewSubjectSha({
        reviewedSha: REVIEWED,
        prHeadSha: REFRESHED,
        drift: { headSha: REFRESHED, authored: 0, baseRefresh: { merges: 0, commits: 0 } },
      }),
    ).toEqual(stands);
    expect(
      reviewSubjectSha({
        reviewedSha: REVIEWED,
        prHeadSha: REVIEWED,
        drift: { ...baseOnly, headSha: REVIEWED },
      }),
    ).toEqual(stands);
  });

  it("has nothing to pin when nothing has been delivered", () => {
    expect(reviewSubjectSha({ reviewedSha: null, prHeadSha: REFRESHED, drift: baseOnly })).toBeNull();
  });
});
