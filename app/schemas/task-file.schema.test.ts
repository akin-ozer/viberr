import { describe, expect, it } from "vitest";
import YAML from "yaml";
import type { YamlMapping } from "~/server/files/frontmatter.server";
import { parseTaskFileContent } from "~/server/files/task-file.server";
import {
  acceptanceBlockedReason,
  conflictingPrBlockedReason,
  activeWorkRevision,
  currentVerdicts,
  deriveValidation,
  judgedFilesDelivery,
  nextWorkRevision,
  revisionLeftWorkspace,
  parseTaskFrontmatter,
  requiredReviewers,
  sanitizeEventAttachmentNames,
  unpushedRevisionBlockedReason,
  unpushedRevisionOf,
  type Engagement,
  type ReviewVerdict,
  type WorkRevision,
  DIVERGED_BRANCH_REMEDY,
} from "./task-file.schema";
import type { PrRef } from "./task-file.schema";

describe("revision-bound review helpers (F10-15/F10-32)", () => {
  const rev1: WorkRevision = {
    id: "rev_1",
    headSha: "a".repeat(40),
    treeSha: "t1".padEnd(40, "0"),
    branch: "vib-1",
    createdAt: "2026-07-04T00:00:00.000Z",
    sourceProfileId: "developer",
  };
  const deliverer: Engagement = {
    profileId: "developer",
    backend: "claude",
    role: "developer",
    delivers: true,
    verdictCapable: false,
  };
  const reviewerA: Engagement = {
    profileId: "reviewer",
    backend: "claude",
    role: "Review",
    delivers: false,
    verdictCapable: true,
  };
  const reviewerB: Engagement = {
    profileId: "qa",
    backend: "codex",
    role: "QA",
    delivers: false,
    verdictCapable: true,
  };
  const nonVerdictReviewer: Engagement = {
    profileId: "docs",
    backend: "claude",
    role: "Docs",
    delivers: false,
    verdictCapable: false,
  };
  const verdict = (
    profileId: string,
    result: ReviewVerdict["result"],
    revisionId = "rev_1",
  ): ReviewVerdict => ({
    profileId,
    revisionId,
    headSha: "a".repeat(40),
    result,
    reason: "",
    at: "2026-07-04T01:00:00.000Z",
    rounds: 1,
  });

  it("requiredReviewers = supporting AND verdict-capable only", () => {
    const fm = { engagements: [deliverer, reviewerA, nonVerdictReviewer] };
    expect(requiredReviewers(fm).map((r) => r.profileId)).toEqual(["reviewer"]);
  });

  it("deriveValidation: none when nothing has been delivered at all", () => {
    expect(
      deriveValidation({ engagements: [reviewerA], workRevision: null, verdicts: [] }),
    ).toBe("none");
  });

  /**
   * Ruling 84 (F39-15), live on ax-clone AX-12. A research task delivers a
   * report, not a commit. Keyed on `workRevision` alone this was forced to
   * `none` however the reviewer had ruled, which printed "**Validation:** none.
   * Review & validation requested changes." in one sentence and shut the rework
   * route ruling 90 licenses, because that needs `failing` or `changed`.
   */
  it("ruling 84: a verdict on a non-commit DELIVERY derives like any other", () => {
    const at = "2026-09-22T06:23:28.646Z";
    const onFiles = (result: "approve" | "request_changes") => ({
      profileId: "reviewer",
      revisionId: `files:${at}`,
      result,
      reason: "",
      at,
      rounds: 1,
    });
    const base = {
      engagements: [deliverer, reviewerA],
      workRevision: null,
      deliveredAt: at,
    };
    // CANARY: restore `if (!activeWorkRevision(...)) return "none"` and all
    // three of these become "none".
    expect(deriveValidation({ ...base, verdicts: [onFiles("request_changes")] })).toBe(
      "failing",
    );
    expect(deriveValidation({ ...base, verdicts: [onFiles("approve")] })).toBe("healthy");
    expect(deriveValidation({ ...base, verdicts: [] })).toBe("changed");
    // A LATER delivery moves the subject, so the old verdict stops counting.
    expect(
      deriveValidation({
        ...base,
        deliveredAt: "2026-09-22T09:00:00.000Z",
        verdicts: [onFiles("approve")],
      }),
    ).toBe("changed");
  });

  /**
   * Ruling 81: the ENGAGED reviewer's gate reads the same subject. Ruling 84
   * moved the verdict, the derivation and the project's rule onto the files a
   * delivering run saved, and this gate still keyed on `workRevision`, so a
   * results task (ruling 268) whose reviewer approved its files was refused
   * with "No reviewed revision yet".
   */
  it("ruling 81: an engaged reviewer's approval of the delivered files releases acceptance, and a later save holds it again", () => {
    const at = "2026-09-27T22:31:54.701Z";
    const fm = {
      engagements: [deliverer, reviewerA],
      workRevision: null,
      deliveredAt: at,
      verdicts: [
        { profileId: "reviewer", revisionId: `files:${at}`, result: "approve" as const, reason: "", at, rounds: 1 },
      ],
    };
    // CANARY: key the gate on `activeWorkRevision` again and this is "No
    // reviewed revision yet".
    expect(acceptanceBlockedReason(fm, null)).toBeNull();
    expect(acceptanceBlockedReason({ ...fm, deliveredAt: "2026-09-27T23:00:00.000Z" }, null)).toBe(
      "Waiting on 1 required reviewer approval of the work delivered on this task.",
    );
  });

  it("deriveValidation: request_changes on the current revision → failing", () => {
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "request_changes")],
      }),
    ).toBe("failing");
  });

  it("deriveValidation: a same-revision approve does NOT mask another reviewer's rejection", () => {
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA, reviewerB],
        workRevision: rev1,
        verdicts: [
          verdict("reviewer", "request_changes"),
          verdict("qa", "approve"),
        ],
      }),
    ).toBe("failing");
  });

  // F19-27 — live-caught on VC-9: a verification-only task accepted through the
  // R19-8 no-change path sat in Done, pill "accepted", wearing "awaiting
  // verdict" on its board card. It has a work revision (its empty branch) and
  // no required reviewer, so the old fall-through returned `changed`. Nobody
  // owed that verdict; the task was closed.
  it("deriveValidation: a no-change completion owes no verdict — none, not 'awaiting verdict'", () => {
    // The exact VC-9 shape: an empty branch, a deliverer, no required reviewer.
    expect(
      deriveValidation({
        engagements: [deliverer],
        workRevision: rev1,
        verdicts: [],
        noChanges: true,
      }),
    ).toBe("none");
    // Same shape WITHOUT the flag still reports the pending state, so the fix
    // is scoped to a verified no-change completion and nothing else.
    expect(
      deriveValidation({ engagements: [deliverer], workRevision: rev1, verdicts: [] }),
    ).toBe("changed");
  });

  it("deriveValidation: a no-change flag never erases a reviewer's APPROVAL", () => {
    // The R19-8 review path mints a verification revision and binds a real
    // verdict to it. That approval is evidence — reporting "none" there would
    // throw away the only signal the acceptance gate has.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "approve")],
        noChanges: true,
      }),
    ).toBe("healthy");
  });

  it("deriveValidation: a no-change flag never hides a recorded request-changes", () => {
    // Defensive ordering: an empty diff should not be able to carry a rejection,
    // but if one is on the record it outranks the flag rather than vanishing.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "request_changes")],
        noChanges: true,
      }),
    ).toBe("failing");
  });

  it("deriveValidation: a force-accept overrides the pending state with 'bypassed' (N20-14/§5c)", () => {
    // The N20-14 repro: a delivered revision with no verdict recorded derives
    // "changed" (= "awaiting verdict"). Once a human force-accepts past the gate,
    // the durable `acceptance: "forced"` fact is the truth — the task is Done
    // because the gate was bypassed, not because a verdict landed.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [],
        acceptance: "forced",
      }),
    ).toBe("bypassed");
    // Canary: without the fact the same shape stays "changed" (awaiting verdict),
    // so the escape is scoped to a real force-accept and nothing else.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [],
      }),
    ).toBe("changed");
  });

  it("deriveValidation: a force-accept never erases a recorded verdict (N20-14)", () => {
    // The bypass fact yields to real evidence, exactly as the no-change arm does:
    // an approval stays "healthy" and a request-changes stays "failing" even on a
    // force-accepted task, so whoever reads it still sees the review that
    // actually happened.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "approve")],
        acceptance: "forced",
      }),
    ).toBe("healthy");
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "request_changes")],
        acceptance: "forced",
      }),
    ).toBe("failing");
  });

  it("deriveValidation: healthy only when EVERY required reviewer approves the current revision", () => {
    const base = { engagements: [deliverer, reviewerA, reviewerB], workRevision: rev1 };
    // Only one of two approved → still changed (pending).
    expect(deriveValidation({ ...base, verdicts: [verdict("reviewer", "approve")] })).toBe("changed");
    // Both approved → healthy.
    expect(
      deriveValidation({
        ...base,
        verdicts: [verdict("reviewer", "approve"), verdict("qa", "approve")],
      }),
    ).toBe("healthy");
  });

  it("deriveValidation: a NEW revision makes prior verdicts stale (F10-32)", () => {
    const rev2: WorkRevision = { ...rev1, id: "rev_2", treeSha: "t2".padEnd(40, "0") };
    // The approve targeted rev_1; against rev_2 it's stale → changed, not healthy.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev2,
        verdicts: [verdict("reviewer", "approve", "rev_1")],
      }),
    ).toBe("changed");
  });

  it("acceptanceBlockedReason: blocks on request_changes, missing approvals, and no revision", () => {
    // No revision + a required reviewer → blocked.
    expect(
      acceptanceBlockedReason({ engagements: [reviewerA], workRevision: null, verdicts: [] }, null),
    ).toMatch(/no reviewed revision/i);
    // request_changes on current revision → blocked.
    expect(
      acceptanceBlockedReason({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "request_changes")],
      }, null),
    ).toMatch(/requests changes/i);
    // A required reviewer hasn't approved → blocked.
    expect(
      acceptanceBlockedReason({
        engagements: [deliverer, reviewerA, reviewerB],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "approve")],
      }, null),
    ).toMatch(/waiting on 1 required reviewer/i);
    // All required reviewers approved current revision → null (allowed).
    expect(
      acceptanceBlockedReason({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "approve")],
      }, null),
    ).toBeNull();
    // No revision AND no required reviewers → allowed (planning / non-repo work).
    expect(
      acceptanceBlockedReason({ engagements: [], workRevision: null, verdicts: [] }, null),
    ).toBeNull();
  });

  it("F19-21: the no-revision refusal names the way OUT of it", () => {
    // Live (VC-5) this refusal was a dead end on a verification-only task:
    // nothing that task would ever do produces a revision, so "nothing to
    // approve" read as permanent and the remaining exits were force-accept,
    // archive, or an operator packet recommending "manually mark Done" — the
    // ceremony bypass R17-2 exists to prevent. Running delivery once IS the
    // path: it inspects the workspace and records the verified no-change
    // outcome, minting the base revision these reviewers then approve.
    const reason = acceptanceBlockedReason({
      engagements: [reviewerA],
      workRevision: null,
      verdicts: [],
    },
      null,
    );
    expect(reason).toContain("run delivery once to verify and record that");
    // Still the same refusal first — the guidance is an addition, not a swap.
    expect(reason).toMatch(/^No reviewed revision yet/);
  });

  it("nextWorkRevision: same tree = same subject (no invalidation); different tree = new revision", () => {
    const same = nextWorkRevision(rev1, {
      id: "rev_x",
      headSha: "b".repeat(40), // different head, SAME tree
      treeSha: rev1.treeSha,
      branch: "vib-1",
      sourceProfileId: "developer",
      createdAt: "2026-07-05T00:00:00.000Z",
    }, []);
    expect(same.changed).toBe(false);
    expect(same.revision.id).toBe("rev_1");

    const diff = nextWorkRevision(rev1, {
      id: "rev_2",
      headSha: "c".repeat(40),
      treeSha: "t2".padEnd(40, "0"),
      branch: "vib-1",
      sourceProfileId: "developer",
      createdAt: "2026-07-05T00:00:00.000Z",
    }, []);
    expect(diff.changed).toBe(true);
    expect(diff.revision.id).toBe("rev_2");
  });

  it("ruling 239: a head the revision reaches by Viberr's own base refreshes is the same subject", () => {
    // Live on ax-clone AX-29: revision 4e6c47d, `main` merged onto it as
    // 278c1ed, the reviewer approved, and the delivery 65 seconds later minted
    // 278c1ed as a new revision because the merge changed the tree. CANARY:
    // drop `refreshedOnly` and the refreshed head mints `rev_2`.
    const merged = "d".repeat(40);
    const refreshes = [{ mergeSha: merged, onto: rev1.headSha, commits: 2 }];
    const head = {
      id: "rev_2",
      headSha: merged,
      treeSha: "t3".padEnd(40, "0"),
      branch: "vib-1",
      sourceProfileId: "developer",
      createdAt: "2026-07-05T00:00:00.000Z",
    };
    expect(nextWorkRevision(rev1, head, refreshes)).toEqual({ revision: rev1, changed: false });
    // Authored work on top of the refresh is a new subject.
    const past = nextWorkRevision(rev1, { ...head, headSha: "9".repeat(40) }, refreshes);
    expect(past.changed).toBe(true);
    // So is a refresh made onto a commit that was never the revision's head.
    const elsewhere = [{ mergeSha: merged, onto: "8".repeat(40), commits: 2 }];
    expect(nextWorkRevision(rev1, head, elsewhere).changed).toBe(true);
  });
});

/** A frontmatter mapping that parses without diagnostics (the first test
 *  below asserts that) — also the clean scaffold for the packet tests. */
const valid = {
  key: "VIB-142",
  title: "Attach execution workspace to task runtime",
  stage: "review",
  readiness: "input_required",
  waiting: "human",
  ownerUserId: "u_abc",
  engagements: [
    { profileId: "developer", backend: "codex", role: "Developer", delivers: true },
  ],
  operator: { assignedAtStageId: "triage" },
  urgent: true,
  validation: "changed",
  branch: "vib-142-attach-workspace",
  pr: { number: 318, state: "review", title: "Attach execution workspace" },
  github: null,
  createdAt: "2026-07-03T06:00:00.000Z",
  updatedAt: "2026-07-04T06:58:00.000Z",
};

describe("ruling 81: the files delivery a reviewer judged last", () => {
  const FIRST = "2026-10-08T15:03:04.630Z";
  const SECOND = "2026-10-08T15:32:35.992Z";
  const verdict = (profileId: string, revisionId: string, at: string): ReviewVerdict => ({
    profileId,
    revisionId,
    result: "request_changes",
    reason: "One label says more than the piece.",
    at,
    rounds: 1,
  });
  const files = (deliveredAt: string, verdicts: ReviewVerdict[]) => ({ workRevision: null, deliveredAt, verdicts });

  it("names the delivery the verdict was on, a later one under review or the same one still", () => {
    // The same delivery too: a file can change on the task without the
    // delivery moving, so there is something to set against it.
    // Canary: answer the task's current stamp.
    const one = [verdict("editor", `files:${FIRST}`, "2026-10-08T15:25:38.000Z")];
    expect(judgedFilesDelivery(files(SECOND, one), "editor")).toBe(FIRST);
    expect(judgedFilesDelivery(files(FIRST, one), "editor")).toBe(FIRST);
  });

  it("reads the reviewer's NEWEST verdict, whatever order the file lists them in, and nobody else's", () => {
    // Canary: take the first verdict found for the profile, or any profile's.
    const THIRD = "2026-10-08T16:10:00.000Z";
    const listed = [
      verdict("editor", `files:${SECOND}`, "2026-10-08T15:51:37.000Z"),
      verdict("editor", `files:${FIRST}`, "2026-10-08T15:25:38.000Z"),
      verdict("reader", `files:${FIRST}`, "2026-10-08T15:55:00.000Z"),
    ];
    for (const verdicts of [listed, [...listed].reverse()]) {
      const fm = files(THIRD, verdicts);
      expect(judgedFilesDelivery(fm, "editor")).toBe(SECOND);
      expect(judgedFilesDelivery(fm, "reader")).toBe(FIRST);
      expect(judgedFilesDelivery(fm, "nobody")).toBeNull();
    }
    // Two verdicts stamped in the same instant: the one written last stands.
    // Canary: keep the earlier entry on a tie.
    const tie = files(THIRD, [
      verdict("editor", `files:${FIRST}`, "2026-10-08T15:51:37.000Z"),
      verdict("editor", `files:${SECOND}`, "2026-10-08T15:51:37.000Z"),
    ]);
    expect(judgedFilesDelivery(tie, "editor")).toBe(SECOND);
  });

  it("answers null for a verdict on a commit, and for a task whose subject is a commit", () => {
    // Canary: drop either guard.
    const onCommit = files(SECOND, [verdict("editor", "rev_1", "2026-10-08T15:25:38.000Z")]);
    expect(judgedFilesDelivery(onCommit, "editor")).toBeNull();
    const commitNow = {
      workRevision: {
        id: "rev_2",
        headSha: "b".repeat(40),
        treeSha: "t".repeat(40),
        branch: "vib-1",
        createdAt: "2026-10-08T15:40:00.000Z",
        sourceProfileId: "developer",
      },
      deliveredAt: SECOND,
      verdicts: [verdict("editor", `files:${FIRST}`, "2026-10-08T15:25:38.000Z")],
    };
    expect(judgedFilesDelivery(commitNow, "editor")).toBeNull();
    // Nothing delivered at all: nothing is under review.
    expect(judgedFilesDelivery({ workRevision: null, deliveredAt: null, verdicts: onCommit.verdicts }, "editor")).toBeNull();
  });
});

describe("parseTaskFrontmatter (tolerant)", () => {
  /** `valid` without the modern `engagements` key — what a task.md written
   *  before the G1 rename carries, so the legacy slots below are the only
   *  source of engagements. */
  const { engagements: _engagements, ...preG1 } = valid;

  it("parses a fully valid frontmatter without diagnostics", () => {
    const result = parseTaskFrontmatter(valid, { fallbackKey: "VIB-142" });
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter.key).toBe("VIB-142");
    expect(result.frontmatter.readiness).toBe("input_required");
    expect(result.frontmatter.urgent).toBe(true);
    expect(result.frontmatter.engagements).toEqual([
      { profileId: "developer", backend: "codex", role: "Developer", delivers: true, verdictCapable: false },
    ]);
    expect(result.unknown).toEqual({});
  });

  it("N20-14: the force-accept `acceptance` fact round-trips (and defaults absent)", () => {
    const bare = parseTaskFrontmatter(valid, { fallbackKey: "VIB-142" });
    expect(bare.diagnostics).toEqual([]);
    expect(bare.frontmatter.acceptance).toBeUndefined();

    const forced = parseTaskFrontmatter(
      { ...valid, acceptance: "forced" },
      { fallbackKey: "VIB-142" },
    );
    expect(forced.diagnostics).toEqual([]);
    expect(forced.frontmatter.acceptance).toBe("forced");

    // An unknown value is tolerated (diagnostic + safe fallback), never a throw.
    const bad = parseTaskFrontmatter(
      { ...valid, acceptance: "waived" },
      { fallbackKey: "VIB-142" },
    );
    expect(bad.frontmatter.acceptance).toBeUndefined();
  });

  it("preserves unknown fields without diagnostics", () => {
    const result = parseTaskFrontmatter(
      { ...valid, futureField: { nested: [1, 2] }, xCustom: "keep me" },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.unknown).toEqual({
      futureField: { nested: [1, 2] },
      xCustom: "keep me",
    });
  });

  it('pr.state is the 4-value enum; unknown strings coerce to "review" (never throw, never drop)', () => {
    // Canonical values pass through untouched.
    for (const state of ["review", "merged", "closed", "accepted"]) {
      const result = parseTaskFrontmatter(
        { ...valid, pr: { number: 318, state, title: "x" } },
        { fallbackKey: "VIB-142" },
      );
      expect(result.frontmatter.pr?.state).toBe(state);
    }
    // A legacy raw GitHub "open" (pre-B3 writes) coerces to "review" instead
    // of dropping the whole PR ref. `pr` is parsed through tolerant(…, null),
    // so a hard enum failure would null the number and title too — the link
    // would then be lost from task.md on the next write.
    const legacy = parseTaskFrontmatter(
      { ...valid, pr: { number: 318, state: "open", title: "x" } },
      { fallbackKey: "VIB-142" },
    );
    expect(legacy.frontmatter.pr).toMatchObject({
      number: 318,
      state: "review",
      title: "x",
    });
    expect(legacy.diagnostics).toEqual([]);
  });

  it("P13-D-28: pr.checks and pr.review are typed, optional, and round-trip", () => {
    const result = parseTaskFrontmatter(
      {
        ...valid,
        pr: {
          number: 318,
          state: "review",
          title: "x",
          checks: { total: 4, passing: 3, failing: 0, pending: 1 },
          review: "changes_requested",
        },
      },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter.pr).toEqual({
      number: 318,
      state: "review",
      title: "x",
      checks: { total: 4, passing: 3, failing: 0, pending: 1 },
      review: "changes_requested",
    });
    // Neither key is invented when absent: a PR ref that has never been
    // reconciled must serialize back byte-identically (no `checks: null` churn
    // on every write, and "absent" stays distinguishable from "read: nothing").
    const bare = parseTaskFrontmatter(valid, { fallbackKey: "VIB-142" });
    expect(Object.keys(bare.frontmatter.pr!)).toEqual(["number", "state", "title"]);
  });

  it("P13-D-28: a garbage pr.review/pr.checks nulls the FIELD, never the whole ref", () => {
    // Same reasoning as `state`: `pr` is read through tolerant(…, null), so an
    // un-caught enum failure would drop number + title + link from task.md.
    const result = parseTaskFrontmatter(
      {
        ...valid,
        pr: { number: 318, state: "review", title: "x", review: "lgtm", checks: 7 },
      },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter.pr).toMatchObject({ number: 318, title: "x" });
    expect(result.frontmatter.pr?.review).toBeNull();
    expect(result.frontmatter.pr?.checks).toBeNull();
  });

  it("P13-D-5: `repo` is no longer a known field — preserved verbatim, never resolved", () => {
    const result = parseTaskFrontmatter(
      { ...valid, repo: "akin-ozer/other-repo" },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    // Not dropped (an existing task.md keeps its line)…
    expect(result.unknown).toEqual({ repo: "akin-ozer/other-repo" });
    // …and not readable as frontmatter — the override is deleted, so no
    // resolver can pick it up again.
    expect("repo" in result.frontmatter).toBe(false);
  });

  // Dynamic-dispatch rework (2026-08-29): the legacy `specialist`/`reviewers`/
  // `consultants` slot absorption is DELETED (preprod, owner's no-back-compat
  // ruling). The three absorption tests that lived here became the two pins
  // below: engagements come ONLY from `engagements:`, and the legacy keys are
  // ordinary unknown keys.
  it("legacy `specialist`/`reviewers`/`consultants` slot keys are never read — engagements come only from `engagements:`", () => {
    const legacy = {
      ...preG1,
      specialist: { profileId: "developer", backend: "codex", role: "Developer" },
      reviewers: [{ profileId: "reviewer", backend: "claude", role: "Reviewer" }],
      consultants: [{ profileId: "old", backend: "codex", role: "Stale" }],
    };
    const result = parseTaskFrontmatter(legacy, { fallbackKey: "VIB-142" });
    // No diagnostic either: an absent `engagements` is an ordinary empty
    // roster, not a parse problem — the legacy keys are simply not consulted.
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter.engagements).toEqual([]);
  });

  it("legacy slot keys survive as UNKNOWN keys on round-trip (preserved verbatim, never resolved)", () => {
    // The same contract `repo` pinned above (P13-D-5): a retired key keeps its
    // line in task.md — the parser must not silently EAT it on the next
    // rewrite. Round-trip preservation is exactly the `unknown` record.
    // (This CAUGHT a rework bug: the unknown-key sweep still carried the
    // pre-rework exclusion written for the deleted absorption, so the keys
    // were silently dropped on the next write. The exclusion is gone now.)
    const legacy = {
      ...preG1,
      specialist: { profileId: "developer", backend: "codex", role: "Developer" },
      reviewers: [{ profileId: "reviewer", backend: "claude", role: "Reviewer" }],
      consultants: [{ profileId: "old", backend: "codex", role: "Stale" }],
    };
    const result = parseTaskFrontmatter(legacy, { fallbackKey: "VIB-142" });
    expect(result.unknown).toEqual({
      specialist: { profileId: "developer", backend: "codex", role: "Developer" },
      reviewers: [{ profileId: "reviewer", backend: "claude", role: "Reviewer" }],
      consultants: [{ profileId: "old", backend: "codex", role: "Stale" }],
    });
  });

  it("an explicit `engagements` key wins over leftover legacy slots (no double-count)", () => {
    const result = parseTaskFrontmatter(
      {
        ...valid,
        specialist: { profileId: "stale-dev", backend: "codex", role: "Developer" },
        reviewers: [{ profileId: "stale-reviewer", backend: "claude", role: "Reviewer" }],
      },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    // Only the `engagements` rows are readable engagements — the legacy slots
    // are never appended (they are unknown keys, pinned above).
    expect(result.frontmatter.engagements).toEqual([
      { profileId: "developer", backend: "codex", role: "Developer", delivers: true, verdictCapable: false },
    ]);
  });

  it("demotes every delivering engagement after the first (single-writer invariant)", () => {
    const result = parseTaskFrontmatter(
      {
        ...valid,
        engagements: [
          { profileId: "developer", backend: "codex", role: "Developer", delivers: true },
          { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: true },
        ],
      },
      { fallbackKey: "VIB-142" },
    );
    expect(result.frontmatter.engagements).toEqual([
      { profileId: "developer", backend: "codex", role: "Developer", delivers: true, verdictCapable: false },
      { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: false, verdictCapable: false },
    ]);
    const demotion = result.diagnostics.find(
      (d) => d.code === "frontmatter.multiple_deliverers",
    );
    expect(demotion?.severity).toBe("warning");
  });

  it("dedupes a profile engaged more than once (profileId-uniqueness, keep first)", () => {
    const result = parseTaskFrontmatter(
      {
        ...valid,
        engagements: [
          { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: true },
          { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: false },
        ],
      },
      { fallbackKey: "VIB-142" },
    );
    // The same profileId corrupts run routing (startAgentRun resolves by the
    // first match) — keep only the first engagement.
    expect(result.frontmatter.engagements).toEqual([
      { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: true, verdictCapable: false },
    ]);
    expect(
      result.diagnostics.find((d) => d.code === "frontmatter.duplicate_engagement")?.severity,
    ).toBe("warning");
  });

  it("missing required fields → warnings + safe fallbacks, never a throw", () => {
    const result = parseTaskFrontmatter({}, { fallbackKey: "VIB-9" });
    expect(result.frontmatter.key).toBe("VIB-9");
    expect(result.frontmatter.title).toBe("VIB-9");
    // A missing stage is NOT invented as `triage` (which would relocate the
    // card): it stays blank + gets an `unresolved_stage` warning, so the board
    // shows it as an unknown stage instead of moving it.
    expect(result.frontmatter.stage).toBe("");
    expect(result.frontmatter.readiness).toBe("ready");
    expect(result.frontmatter.waiting).toBe("none");
    expect(result.frontmatter.urgent).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("frontmatter.missing_key");
    expect(codes).toContain("frontmatter.missing_field");
    expect(codes).toContain("frontmatter.unresolved_stage");
    expect(result.diagnostics.every((d) => d.severity !== "error")).toBe(true);
  });

  it("broken/invalid stage → blank marker + unresolved_stage warning (no `triage` relocation)", () => {
    // A present-but-unparseable stage (empty string here; also non-strings)
    // must NOT jump to a hardcoded `triage`. It falls back to a blank stage so
    // the projection parks the card in the board's unknown-stage bucket.
    const result = parseTaskFrontmatter(
      { ...valid, stage: "" },
      { fallbackKey: "VIB-142" },
    );
    expect(result.frontmatter.stage).toBe("");
    const stageDiag = result.diagnostics.find((d) => d.path === "stage");
    expect(stageDiag?.code).toBe("frontmatter.unresolved_stage");
    // Warning severity → floors readiness at input_required (never invents a
    // healthier state); it is not an integrity error.
    expect(stageDiag?.severity).toBe("warning");
  });

  it("invalid enum values → warning diagnostics with field paths", () => {
    const result = parseTaskFrontmatter(
      { ...valid, readiness: "done", waiting: "everyone", validation: 42 },
      { fallbackKey: "VIB-142" },
    );
    expect(result.frontmatter.readiness).toBe("ready"); // fallback
    expect(result.frontmatter.waiting).toBe("none");
    expect(result.frontmatter.validation).toBe("none");
    const paths = result.diagnostics.map((d) => d.path);
    expect(paths).toContain("readiness");
    expect(paths).toContain("waiting");
    expect(paths).toContain("validation");
  });

  it("key mismatch with directory → directory wins + error diagnostic", () => {
    const result = parseTaskFrontmatter(valid, { fallbackKey: "VIB-999" });
    expect(result.frontmatter.key).toBe("VIB-999");
    const diag = result.diagnostics.find(
      (d) => d.code === "frontmatter.key_mismatch",
    );
    expect(diag?.severity).toBe("error");
  });

  it("non-mapping frontmatter → hard stop + all defaults", () => {
    const result = parseTaskFileContent("---\njust a string\n---\n", {
      fallbackKey: "VIB-7",
    });
    expect(result.parsed.frontmatter.key).toBe("VIB-7");
    expect(result.diagnostics.some((d) => d.hardStop)).toBe(true);
  });

  it("absent urgent stays false with NO diagnostic (optional by contract)", () => {
    const { urgent: _urgent, ...withoutUrgent } = valid;
    const result = parseTaskFrontmatter(withoutUrgent, {
      fallbackKey: "VIB-142",
    });
    expect(result.frontmatter.urgent).toBe(false);
    expect(result.diagnostics.filter((d) => d.path === "urgent")).toEqual([]);
  });
});

describe("packet block parse (tolerant)", () => {
  /** Routes a packet value through a full task.md parse — the packet decode
   *  lives at the file boundary in `parsePacketSection` (task-file.server.ts),
   *  under a scaffold (`valid` frontmatter, goal, timeline) that contributes
   *  no diagnostics of its own. */
  const parsePacket = (packet: YamlMapping | null) => {
    const content = [
      "---",
      YAML.stringify(valid).trimEnd(),
      "---",
      "",
      "## Goal",
      "",
      "g",
      "",
      "## Packet",
      "",
      "```yaml",
      YAML.stringify(packet).trimEnd(),
      "```",
      "",
      "## Timeline",
      "",
    ].join("\n");
    const { parsed, diagnostics } = parseTaskFileContent(content, {
      fallbackKey: "VIB-142",
    });
    return { packet: parsed.packet, diagnostics };
  };

  it("F20-6: a discard_branch option parses with its kind intact", () => {
    const { packet, diagnostics } = parsePacket({
      type: "input",
      kind: "Completion report",
      title: "Discard the empty branch, or refine the goal?",
      options: [
        { kind: "discard_branch", t: "Discard the empty vib-2 branch", d: "", rec: true },
        { kind: "edit_goal", t: "Refine the goal", d: "", rec: false },
      ],
    });
    expect(diagnostics).toEqual([]);
    expect(packet?.options[0]?.kind).toBe("discard_branch");
  });

  it("invalid packet → null + error diagnostic (never a throw)", () => {
    const { packet, diagnostics } = parsePacket({ type: "nope" });
    expect(packet).toBeNull();
    expect(diagnostics[0]?.code).toBe("packet.invalid");
  });

  it("multiple recommended options → info diagnostic", () => {
    const { diagnostics } = parsePacket({
      type: "blocked",
      kind: "Blocked decision",
      title: "t",
      options: [
        { kind: "redirect", t: "a", rec: true },
        { kind: "redirect", t: "b", rec: true },
      ],
    });
    expect(diagnostics.some((d) => d.code === "packet.rec_count")).toBe(true);
  });

  it("ruling 68: no recommended option is a legitimate packet, with no diagnostic", () => {
    // An agent's question it has no pick on carries no `rec`; the task page
    // printed "0 recommended options (expected exactly 1)" as a heads-up on
    // every such packet. CANARY: restore `recCount !== 1`.
    const { packet, diagnostics } = parsePacket({
      type: "input",
      kind: "Agent question",
      title: "May /talks list the AWS customer panel?",
      options: [
        { kind: "custom", t: "List it", rec: false },
        { kind: "custom", t: "Leave it out", rec: false, reply: true },
      ],
    });
    expect(diagnostics.some((d) => d.code === "packet.rec_count")).toBe(false);
    // `reply` round-trips as a typed field.
    expect(packet!.options.map((o) => o.reply)).toEqual([undefined, true]);
  });

  it("null/undefined → no packet, no diagnostics", () => {
    expect(parsePacket(null)).toEqual({ packet: null, diagnostics: [] });
  });
});

describe("sanitizeEventAttachmentNames (P21)", () => {
  it("keeps clean names, drops separators/control chars, dedupes, caps at 20", () => {
    const names = [
      "page-2026-08-19T17-38-40-756Z.png",
      "page-2026-08-19T17-38-40-756Z.png", // duplicate
      "../traversal.png",
      "nested/inside.png",
      "back\\slash.png",
      "forged\nrow.png",
      " padded.png", // trims differently — cannot round-trip
      "",
      "ok two words.yml",
    ];
    expect(sanitizeEventAttachmentNames(names)).toEqual([
      "page-2026-08-19T17-38-40-756Z.png",
      "ok two words.yml",
    ]);
    const many = Array.from({ length: 30 }, (_, i) => `shot-${i}.png`);
    expect(sanitizeEventAttachmentNames(many)).toHaveLength(20);
  });

  it("returns null when nothing usable survives — callers omit the field", () => {
    expect(sanitizeEventAttachmentNames(null)).toBeNull();
    expect(sanitizeEventAttachmentNames(undefined)).toBeNull();
    expect(sanitizeEventAttachmentNames([])).toBeNull();
    expect(sanitizeEventAttachmentNames(["../x", "a/b"])).toBeNull();
    expect(sanitizeEventAttachmentNames(["x".repeat(201)])).toBeNull();
  });
});

/**
 * The engagement roster is the task's delivery contract: the `delivers: true`
 * row owns the workspace and branch, and the verdict-capable rows are the
 * required reviewers acceptance is gated on. Parsing the list as a WHOLE meant
 * one unparseable row emptied all of it — and since the diagnostic is only a
 * warning the file stays writable, so the next `updateTaskFile` serialized
 * `engagements: []` back over the rows that had been fine.
 */
describe("parseTaskFrontmatter — per-entry engagement tolerance", () => {
  it("keeps valid engagements and drops only the malformed row", () => {
    const { frontmatter, diagnostics } = parseTaskFrontmatter(
      {
        key: "VIB-1",
        engagements: [
          {
            profileId: "developer",
            backend: "codex",
            role: "Developer",
            delivers: true,
          },
          // Malformed: `Claude` is not one of the backend options.
          { profileId: "reviewer", backend: "Claude", role: "Reviewer" },
          {
            profileId: "qa",
            backend: "claude",
            role: "QA",
            verdictCapable: true,
          },
        ],
      },
      { fallbackKey: "VIB-1" },
    );

    expect(frontmatter.engagements.map((e) => e.profileId)).toEqual([
      "developer",
      "qa",
    ]);
    // The branch owner survives one bad neighbour.
    expect(frontmatter.engagements.some((e) => e.delivers)).toBe(true);
    expect(diagnostics.some((d) => d.path === "engagements[1]")).toBe(true);
  });

  it("a non-list `engagements` still degrades to empty rather than throwing", () => {
    const { frontmatter, diagnostics } = parseTaskFrontmatter(
      { key: "VIB-1", engagements: "not-a-list" },
      { fallbackKey: "VIB-1" },
    );
    expect(frontmatter.engagements).toEqual([]);
    expect(diagnostics.some((d) => d.path === "engagements")).toBe(true);
  });
});

describe("parseTaskFrontmatter — per-row github.commits tolerance (C01-A8)", () => {
  it("one malformed commit row drops only itself; unownedPr and changed survive", () => {
    // Canary: revert githubWithCleanCommits and the whole `github` object
    // parses to null — the R15-15 collision fact vanishes with the bad row.
    const { frontmatter, diagnostics } = parseTaskFrontmatter(
      {
        key: "VIB-1",
        github: {
          commits: [
            { sha: "a91f7c2", msg: "[VIB-1] first" },
            // Malformed: a hand-edited sha that YAML read as a number.
            { sha: 1234567, msg: "[VIB-1] second" },
            { sha: "c0ffee1", msg: "[VIB-1] third" },
          ],
          changed: { files: 2, add: 10, del: 1 },
          unownedPr: 232,
        },
      },
      { fallbackKey: "VIB-1" },
    );
    expect(frontmatter.github).not.toBeNull();
    expect(frontmatter.github!.commits.map((c) => c.sha)).toEqual([
      "a91f7c2",
      "c0ffee1",
    ]);
    expect(frontmatter.github!.unownedPr).toBe(232);
    expect(frontmatter.github!.changed).toEqual({ files: 2, add: 10, del: 1 });
    expect(
      diagnostics.some(
        (d) => d.code === "github.invalid_commit" && d.path === "github.commits[1]",
      ),
    ).toBe(true);
    expect(diagnostics.some((d) => d.path === "github")).toBe(false);
  });

  it("a `github` value that is not a mapping still degrades to null with the field diagnostic", () => {
    const { frontmatter, diagnostics } = parseTaskFrontmatter(
      { key: "VIB-1", github: "not-a-mapping" },
      { fallbackKey: "VIB-1" },
    );
    expect(frontmatter.github).toBeNull();
    expect(diagnostics.some((d) => d.path === "github")).toBe(true);
  });
});

describe("parseTaskFrontmatter — per-entry verdict/schedule tolerance", () => {
  // A whole-array wipe of these lists PERSISTS: the diagnostic is a warning, so
  // the file stays writable and the next updateTaskFile serializes `[]` back.
  it("keeps valid verdicts and drops only the malformed row", () => {
    const good = (profileId: string, at: string) => ({
      profileId,
      revisionId: "rev-1",
      headSha: "sha-1",
      result: "approve" as const,
      at,
    });
    const { frontmatter, diagnostics } = parseTaskFrontmatter(
      {
        key: "VIB-1",
        verdicts: [
          good("reviewer-a", "2026-08-31T00:00:00Z"),
          // Malformed: `revisionId`/`headSha`/`at` missing.
          { profileId: "reviewer-b", result: "approve" },
          good("reviewer-c", "2026-08-31T01:00:00Z"),
        ],
      },
      { fallbackKey: "VIB-1" },
    );
    expect(frontmatter.verdicts.map((v) => v.profileId)).toEqual([
      "reviewer-a",
      "reviewer-c",
    ]);
    expect(diagnostics.some((d) => d.path === "verdicts[1]")).toBe(true);
  });

  it("keeps valid schedules and drops only the malformed row", () => {
    const { frontmatter, diagnostics } = parseTaskFrontmatter(
      {
        key: "VIB-1",
        schedules: [
          { id: "s-1", action: "not-a-real-action" }, // malformed: bad enum
          {
            id: "s-2",
            action: "run-operator",
            dueAt: "2026-08-31T09:00:00Z",
            createdBy: "u1",
            createdAt: "2026-08-31T00:00:00Z",
          },
        ],
      },
      { fallbackKey: "VIB-1" },
    );
    // The good occurrence survives its malformed neighbour.
    expect(frontmatter.schedules.map((s) => s.id)).toContain("s-2");
    expect(diagnostics.some((d) => d.path === "schedules[0]")).toBe(true);
  });
});

/**
 * Pass 34 — the frontmatter additions. Each field is parsed the way its loss
 * would demand: the two LISTS per row (a bad row drops only itself), the
 * optional PR facts with the absent-means-never-read convention.
 */
describe("pass 34 frontmatter additions", () => {
  const base = { key: "VIB-9", title: "T", stage: "impl", readiness: "ready", waiting: "none" };

  it("ruling 55: `blockedBy` round-trips canonicalized, absent reads [] with no diagnostic, a malformed row drops only itself", () => {
    // Canary: delete the `blockedBy: tolerantRows(...)` line from the parse
    // (falling back to `[]`) and the first assertion reads `[]`.
    const ok = parseTaskFrontmatter({ ...base, blockedBy: ["jc-6", "ax-12"] });
    expect(ok.frontmatter.blockedBy).toEqual(["JC-6", "AX-12"]);
    expect(ok.diagnostics.filter((d) => d.path?.startsWith("blockedBy"))).toEqual([]);

    const absent = parseTaskFrontmatter(base);
    expect(absent.frontmatter.blockedBy).toEqual([]);
    expect(absent.diagnostics.filter((d) => d.path?.startsWith("blockedBy"))).toEqual([]);
    // Not a frontmatter unknown either — it is a known key.
    expect(absent.unknown).toEqual({});

    const mixed = parseTaskFrontmatter({ ...base, blockedBy: ["nope", "JC-7"] });
    expect(mixed.frontmatter.blockedBy).toEqual(["JC-7"]);
    const diag = mixed.diagnostics.find((d) => d.code === "frontmatter.invalid_field");
    expect(diag?.path).toBe("blockedBy[0]");
    expect(diag?.message).toContain("nope");

    // Ruling 55: a goal link is no longer a spelling. The boot conversion
    // respelled every stored one by task key, so one written by hand since is
    // a malformed row like any other, and drops only itself.
    const legacy = parseTaskFrontmatter({ ...base, blockedBy: ["goal-1 link 3", "JC-7"] });
    expect(legacy.frontmatter.blockedBy).toEqual(["JC-7"]);
    expect(legacy.diagnostics.find((d) => d.path === "blockedBy[0]")?.message).toContain("goal-1 link 3");
  });

  it("ruling 239: `baseRefreshes` round-trips per row and absent reads []", () => {
    const row = {
      mergeSha: "m".repeat(40),
      baseSha: "b".repeat(40),
      base: "main",
      commits: 4,
      at: "2026-09-03T11:16:55.000Z",
    };
    const ok = parseTaskFrontmatter({ ...base, baseRefreshes: [row, { mergeSha: 1 }] });
    expect(ok.frontmatter.baseRefreshes).toEqual([row]);
    expect(ok.diagnostics.find((d) => d.path === "baseRefreshes[1]")).toBeTruthy();
    expect(parseTaskFrontmatter(base).frontmatter.baseRefreshes).toEqual([]);
  });

  it("ruling 239: `pr.revisionDrift` is the authored/baseRefresh record, and a fast-forward refresh (merges: 0) is legal", () => {
    const pr = {
      number: 1,
      state: "review",
      title: "t",
      revisionDrift: { headSha: "h".repeat(40), authored: 0, baseRefresh: { merges: 0, commits: 3 } },
    };
    expect(parseTaskFrontmatter({ ...base, pr }).frontmatter.pr?.revisionDrift).toEqual(
      pr.revisionDrift,
    );
    // The OLD `{ aheadBy }` shape is garbage now: the field nulls, the ref survives.
    const legacy = parseTaskFrontmatter({
      ...base,
      pr: { ...pr, revisionDrift: { aheadBy: 5, headSha: "h".repeat(40) } },
    });
    expect(legacy.frontmatter.pr?.number).toBe(1);
    expect(legacy.frontmatter.pr?.revisionDrift).toBeNull();
  });

  it("ruling 243: `pr.headSha` and `pr.unpushedRevision` are optional keys that round-trip", () => {
    const pr = {
      number: 10,
      state: "review",
      title: "t",
      headSha: "6".repeat(40),
      unpushedRevision: { revisionSha: "3".repeat(40), prHeadSha: "6".repeat(40), relation: "unknown" },
    };
    const fm = parseTaskFrontmatter({ ...base, pr }).frontmatter;
    expect(fm.pr?.headSha).toBe("6".repeat(40));
    expect(fm.pr?.unpushedRevision).toEqual(pr.unpushedRevision);
    const bare = parseTaskFrontmatter({ ...base, pr: { number: 10, state: "review", title: "t" } })
      .frontmatter;
    expect(bare.pr).not.toHaveProperty("headSha");
    expect(bare.pr).not.toHaveProperty("unpushedRevision");
  });

  it("ruling 63: a packet records `decided` and an edit_goal option carries `goalDraft`", () => {
    const parsed = parseTaskFileContent(
      [
        "---",
        "key: VIB-9",
        "title: T",
        "stage: impl",
        "readiness: input_required",
        "waiting: human",
        "---",
        "## Goal",
        "",
        "g",
        "",
        "## Packet",
        "",
        "```yaml",
        "type: input",
        "kind: Decision required",
        "title: Align the goal?",
        "awaiting: goal_edit",
        "decided:",
        "  optionIndex: 1",
        "  at: 2026-09-03T11:12:00.000Z",
        "  byUserId: u_arda",
        "options:",
        "  - kind: custom",
        "    t: Keep it",
        "  - kind: edit_goal",
        "    t: Align the goal",
        "    d: why",
        "    rec: true",
        "    goalDraft: |",
        "      Deliverable: the search page.",
        "```",
        "",
        "## Timeline",
        "",
      ].join("\n"),
      { fallbackKey: "VIB-9" },
    );
    const packet = parsed.parsed.packet!;
    expect(packet.awaiting).toBe("goal_edit");
    expect(packet.decided).toEqual({
      optionIndex: 1,
      at: "2026-09-03T11:12:00.000Z",
      byUserId: "u_arda",
    });
    expect(packet.options[1]?.goalDraft).toBe("Deliverable: the search page.\n");
    expect(packet.options[0]).not.toHaveProperty("goalDraft");
  });

  it("ruling 99: a recommendation carries `forHeadSha`", () => {
    const fm = parseTaskFrontmatter({
      ...base,
      recommendations: [
        { id: "r1", kind: "accept_completion", label: "Accept", forHeadSha: "a".repeat(40) },
        { id: "r2", kind: "run_agent", label: "Run", profileId: "dev" },
      ],
    }).frontmatter;
    expect(fm.recommendations[0]?.forHeadSha).toBe("a".repeat(40));
    expect(fm.recommendations[1]).not.toHaveProperty("forHeadSha");
  });
});

/**
 * Ruling 243 (pass 34, F34-11): the unpushed-revision gate. Its answers depend
 * on the CURRENT revision (a record for an older one is stale and reads as
 * nothing) and its remedy is always "deliver", never "rebase".
 *
 * Canary: drop the `record.revisionSha !== currentRevisionSha` comparison in
 * `unpushedRevisionOf` and the stale case answers the record.
 */
describe("unpushedRevisionOf / unpushedRevisionBlockedReason (ruling 243)", () => {
  const rev = "385047c".padEnd(40, "0");
  const old = "6004958".padEnd(40, "0");
  const pr = (relation: "behind" | "diverged" | "unknown", revisionSha = rev) => ({
    number: 10,
    state: "review" as const,
    title: "t",
    headSha: old,
    unpushedRevision: { revisionSha, prHeadSha: old, relation },
  });

  it("answers the record only for the task's current revision on a live PR", () => {
    expect(unpushedRevisionOf(pr("behind"), rev)).toEqual(pr("behind").unpushedRevision);
    // Stale: written for a revision that is no longer current.
    expect(unpushedRevisionOf(pr("behind", "1215ab44".padEnd(40, "0")), rev)).toBeNull();
    // No current revision, no PR, no record: nothing.
    expect(unpushedRevisionOf(pr("behind"), null)).toBeNull();
    expect(unpushedRevisionOf(null, rev)).toBeNull();
    expect(unpushedRevisionOf({ number: 10, state: "review", title: "t" }, rev)).toBeNull();
    // A merged or closed PR has no push to offer.
    expect(unpushedRevisionOf({ ...pr("behind"), state: "merged" }, rev)).toBeNull();
    expect(unpushedRevisionOf({ ...pr("behind"), state: "closed" }, rev)).toBeNull();
  });

  it("the refusal names the revision, the PR head and DELIVER, never rebase", () => {
    const behind = unpushedRevisionBlockedReason(pr("behind"), rev, "JC-3")!;
    expect(behind).toContain("JC-3's delivered revision `385047c` is not on PR #10");
    expect(behind).toContain("`6004958`");
    expect(behind).toContain("Deliver the branch to push it");
    expect(behind).not.toMatch(/rebase/i);
    // Ruling 243: `unknown` used to take the `behind` sentence, whose
    // premise ("a behind or absent remote reaches the PR by a plain push") it
    // does not satisfy — it is written when the compare could not be READ, so
    // the remote may be diverged. CANARY: fall through to the behind arm and
    // the uncertainty disappears behind a promise that the push will land.
    const unknown = unpushedRevisionBlockedReason(pr("unknown"), rev, "JC-3")!;
    expect(unknown).toContain("could not read how the two relate");
    expect(unknown).toContain("Deliver the branch to try the push");
    expect(unknown).toContain("if the remote has diverged it will refuse");
    expect(unknown).not.toMatch(/rebase/i);
    const diverged = unpushedRevisionBlockedReason(pr("diverged"), rev, "JC-3")!;
    expect(diverged).toContain("holds commits this workspace does not");
    // Ruling 230: this used to say "Resolve the branch history" and stop —
    // an obligation with no act in it, in a sentence whose own header claimed
    // it "says which". It now carries the shared remedy.
    expect(diverged).toContain(DIVERGED_BRANCH_REMEDY);
    // Ruling 243's guard survives inverted: the word may appear ONLY as the
    // thing not to do. Anything that reads as an instruction to rebase is what
    // this line has always been here to catch.
    expect(diverged).toContain("never a rebase");
    expect(diverged).not.toMatch(/\brebase (the|it|onto|your)\b/i);
    expect(unpushedRevisionBlockedReason(pr("behind", "x".repeat(40)), rev, "JC-3")).toBeNull();
  });
});

describe("ruling 234 (pass 35, G35-6): a discarded revision is retired, not under review", () => {
  const delivered: WorkRevision = {
    id: "rev_d1",
    headSha: "d".repeat(40),
    treeSha: "e".repeat(40),
    branch: "knc-21",
    createdAt: "2026-09-06T18:56:57.000Z",
    sourceProfileId: "developer",
    kind: "delivered",
  };
  const discarded: WorkRevision = { ...delivered, kind: "discarded" };
  const reviewer: Engagement = {
    profileId: "reviewer",
    backend: "claude",
    role: "Review",
    delivers: false,
    verdictCapable: true,
  };
  const approve: ReviewVerdict = {
    profileId: "reviewer",
    revisionId: "rev_d1",
    headSha: "d".repeat(40),
    result: "approve",
    reason: "fine",
    at: "2026-09-06T19:00:00.000Z",
    rounds: 1,
  };

  it("activeWorkRevision answers null for a discarded revision and the same object otherwise", () => {
    // Canary: return `rev` unconditionally and the discarded record reads as live.
    expect(activeWorkRevision(discarded)).toBeNull();
    expect(activeWorkRevision(delivered)).toBe(delivered);
    expect(activeWorkRevision(null)).toBeNull();
    expect(activeWorkRevision(undefined)).toBeNull();
  });

  it("deriveValidation is `none` and currentVerdicts empty over a discarded revision, whatever the verdicts say", () => {
    // Canary: drop the `activeWorkRevision` read in either helper and the
    // approve bound to the retired head keeps the task `healthy`.
    expect(
      deriveValidation({ engagements: [reviewer], workRevision: delivered, verdicts: [approve] }),
    ).toBe("healthy");
    expect(
      deriveValidation({ engagements: [reviewer], workRevision: discarded, verdicts: [approve] }),
    ).toBe("none");
    expect(currentVerdicts({ workRevision: discarded, verdicts: [approve] })).toEqual([]);
  });

  it("nextWorkRevision mints a fresh id over a discarded revision even for the same tree", () => {
    // Canary: compare `current` instead of `activeWorkRevision(current)` and the
    // re-created head is reported as the same subject, keeping `discarded`.
    const same = {
      id: "rev_new",
      headSha: "f".repeat(40),
      treeSha: "e".repeat(40),
      branch: "knc-21",
      sourceProfileId: "developer",
      createdAt: "2026-09-07T08:00:00.000Z",
    };
    expect(nextWorkRevision(delivered, same, [])).toEqual({ revision: delivered, changed: false });
    const minted = nextWorkRevision(discarded, same, []);
    expect(minted.changed).toBe(true);
    expect(minted.revision.id).toBe("rev_new");
    expect(minted.revision.kind).toBe("delivered");
  });

  it("revisionLeftWorkspace: a reported head is local until a PR, an unowned PR or a push says otherwise", () => {
    const base = { pr: null, github: null, workRevision: delivered };
    // Canary: test `workRevision !== null` here and the reported head is "delivered".
    expect(revisionLeftWorkspace(base)).toBeNull();
    expect(
      revisionLeftWorkspace({ ...base, github: { commits: [{ sha: "d".repeat(7), msg: "x" }], changed: null } }),
    ).toBeNull();
    expect(revisionLeftWorkspace({ ...base, pr: { number: 10, state: "closed", title: "t" } })).toEqual({
      kind: "pr",
      number: 10,
    });
    expect(
      revisionLeftWorkspace({ ...base, github: { commits: [], changed: null, unownedPr: 33 } }),
    ).toEqual({ kind: "unowned_pr", number: 33 });
    expect(
      revisionLeftWorkspace({
        ...base,
        workRevision: { ...delivered, pushedAt: "2026-09-06T19:10:35.000Z" },
      }),
    ).toEqual({ kind: "pushed", at: "2026-09-06T19:10:35.000Z", headSha: "d".repeat(40) });
    // A discarded revision's push stamp is history too.
    expect(
      revisionLeftWorkspace({
        ...base,
        workRevision: { ...discarded, pushedAt: "2026-09-06T19:10:35.000Z" },
      }),
    ).toBeNull();
  });

  it("the acceptance gate refuses a discarded revision by naming delivery, not an approval nobody can give", () => {
    // Ruling 234 lists "the acceptance gates" among the readers that go
    // through `activeWorkRevision`. Canary: read `fm.workRevision` raw at the
    // first arm of `acceptanceBlockedReason` — the retired record takes the
    // required-reviewer arm, so this task is told to wait for an approval of a
    // revision the verdict binding can no longer pin one to, on the same
    // frontmatter whose validation pill reads "no validation".
    const fm = { engagements: [reviewer], workRevision: discarded, verdicts: [approve] };
    expect(deriveValidation(fm)).toBe("none");
    const reason = acceptanceBlockedReason(fm, null)!;
    expect(reason).toContain("No reviewed revision yet");
    expect(reason).toContain("run delivery once to verify and record that");
    expect(reason).not.toContain("current revision");
    // The live record still walks the required-reviewer path, approved here.
    expect(
      acceptanceBlockedReason({ ...fm, workRevision: delivered }, null),
    ).toBeNull();
  });
});

/**
 * Ruling 230 — a diverged branch has ONE remedy sentence.
 *
 * The phrase was invented five times, in five files, and every one of them
 * said that a person should resolve the history without naming the act that
 * does. Each door's own suite pins that it prints this sentence: workspace
 * delivery, update-branch, the packet outcome (react-progress) and
 * delivery-decision.
 */
describe("DIVERGED_BRANCH_REMEDY (ruling 230)", () => {
  it("names the act and the thing that causes the divergence", async () => {
    const { DIVERGED_BRANCH_REMEDY } = await import("./task-file.schema");
    expect(DIVERGED_BRANCH_REMEDY).toContain("MERGE");
    expect(DIVERGED_BRANCH_REMEDY).toContain("never a rebase or an amend");
    // Why, not just what: the owner had to supply this half by hand on SHOP-11.
    expect(DIVERGED_BRANCH_REMEDY).toContain("published commits");
  });
});

/**
 * Ruling 242 (F39-32), measured live on ax-clone AX-18.
 *
 * The Surface Developer resolved the conflict in `internal/cli/render.go` and
 * the operator pushed the merge commit `d44e874` to PR #16. GitHub recomputes
 * mergeability asynchronously, so the next read answered "unknown" and the
 * reconciler's rule -- "an unread value keeps the last-known one for the same
 * PR" -- carried the `conflicting` measured at `5ae0752`, the commit that had
 * just been superseded. The operator was refused `transition_stage` twice in
 * fifteen seconds on a conflict that no longer existed, and the policy engine
 * then told the human the operator had held the stage deliberately.
 *
 * `paths` has been pinned to its head since ruling 242. The verdict that
 * BLOCKS had no pin at all.
 */
describe("ruling 242: a conflict verdict belongs to the head it was measured on", () => {
  const prAt = (mergeableAt: string | null, headSha: string) => {
    const pr: PrRef = {
      number: 16,
      state: "review",
      title: "[AX-18] ax watch: the live event stream",
      mergeable: "conflicting",
      headSha,
    };
    // Absent, not null: an unpinned verdict is one no pass ever measured.
    if (mergeableAt) pr.mergeableAt = mergeableAt;
    return { pr };
  };

  it("blocks while the verdict and the live head are the same commit", () => {
    const reason = conflictingPrBlockedReason(prAt("5ae0752", "5ae0752"), "AX-18");
    expect(reason).toContain("conflicts with the base branch");
    // Ruling 230: the remedy is a merge, and the sentence FORBIDS the rebase
    // rather than leaving it open to the one reader with no tool.
    expect(reason).toContain("merging the base INTO it");
    expect(reason).toContain("never by rebasing");
  });

  it("does NOT block once the head has moved past the commit it was measured on", () => {
    // The exact shape on disk at 17:08 on 2026-09-22.
    expect(conflictingPrBlockedReason(prAt("5ae0752", "d44e874"), "AX-18")).toBeNull();
  });

  it("still blocks when the verdict was never pinned, so an old file is not silently unblocked", () => {
    expect(conflictingPrBlockedReason(prAt(null, "d44e874"), "AX-18")).not.toBeNull();
  });
});
