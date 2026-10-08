import { describe, expect, it } from "vitest";
import { describeRevisionDrift } from "~/shared/revision-drift";
import { reviewRowSub, type ReviewRowView } from "./review-helpers";

const base: ReviewRowView = {
  key: "VIB-1",
  title: "t",
  stageName: "Review",
  atAcceptanceBoundary: true,
  priority: "normal",
  labels: [],
  dueDate: null,
  waiting: "agent",
  packet: null,
  goalEditPending: false,
  latestEventText: null,
  pr: null,
  validation: "none",
  blockReason: null,
  lastActivityAt: null,
  quiet: false,
  continuity: null,
};

describe("reviewRowSub", () => {
  it("prefers the packet header", () => {
    expect(
      reviewRowSub({ ...base, packet: { kind: "Completion report", title: "Accept?" } }),
    ).toBe("Completion report: Accept?");
  });

  it("falls back to the newest event text (markdown stripped)", () => {
    expect(
      reviewRowSub({ ...base, latestEventText: "**Transition request:** move on" }),
    ).toBe("Transition request: move on");
  });

  // F19-31: this test USED to pin "Agent working — the packet arrives at the
  // boundary." for a `waiting: "none"` row, which is the defect: the row claims
  // a live agent run while the board renders no wait tag at all for the very
  // same stored value. The placeholder is per-`waiting` now, so the test names
  // which placeholder each value gets instead of pinning one for all three.
  it("falls back to the placeholder matching the row's `waiting` when it has neither packet nor events", () => {
    // Nothing is waiting on either side — say exactly that, claim no agent.
    expect(reviewRowSub({ ...base, waiting: "none" })).toBe(
      "At the review boundary: no agent is running and no decision is pending.",
    );
    // The agent sentence is not deleted, just no longer the catch-all: a row
    // that really IS waiting on an agent still gets it.
    expect(reviewRowSub({ ...base, waiting: "agent" })).toBe(
      "Agent working. The packet arrives at the boundary.",
    );
    // R8-3: a human-waiting bare row names a person, not an agent.
    expect(reviewRowSub({ ...base, waiting: "human" })).toBe(
      "Waiting at the review boundary. Needs a human decision.",
    );
  });
});

describe("reviewRowSub live PR state (P14-LV-05)", () => {
  it("describes a REOPENED PR by its live state, never by the stale closure note", () => {
    // Live repro: #103 was closed on GitHub, the divergence note was written,
    // the PR was reopened and reconciled — and the queue kept telling the human
    // the PR was closed, because the subline was built from the last note.
    const sub = reviewRowSub({
      ...base,
      pr: { number: 103, state: "review" },
      goalEditPending: false,
      latestEventText:
        "**Divergence:** PR #103 was closed on GitHub without merging, but VM-4 is still active.",
    });
    expect(sub).toBe("PR #103 is open for review on GitHub.");
    expect(sub).not.toContain("closed");
  });

  it("ruling 135: an unpushed delivered revision outranks the conflict subline and names the push", () => {
    // Canary: move the `unpushedRevision` branch below the `mergeable` one.
    const behind = reviewRowSub({
      ...base,
      pr: { number: 103, state: "review", mergeable: "conflicting", headSha: "1".repeat(40), unpushedRevision: { revisionSha: "9".repeat(40), prHeadSha: "1".repeat(40), relation: "behind" } },
    });
    expect(behind).toContain("does not carry the delivered revision 9999999");
    expect(behind).toContain("Deliver the branch to push it");
    expect(behind).not.toContain("conflicts with the base branch");
    const diverged = reviewRowSub({
      ...base,
      pr: { number: 103, state: "review", unpushedRevision: { revisionSha: "9".repeat(40), prHeadSha: "1".repeat(40), relation: "diverged" } },
    });
    expect(diverged).toContain("holds commits the workspace does not");
    expect(diverged).toContain("Resolve the history");
  });

  it("ruling 132: a base refresh prints the canonical sentence verbatim, never 'unreviewed'", () => {
    // Canary: restore the summed-count arm (`aheadBy`-style) over the record.
    const record = { headSha: "b".repeat(40), authored: 0, baseRefresh: { merges: 1, commits: 4 } };
    const sub = reviewRowSub({ ...base, pr: { number: 130, state: "review", revisionDrift: record } });
    expect(sub).toContain(`PR #130 is open. ${describeRevisionDrift(record).sentence}.`);
    expect(sub).not.toContain("unreviewed");
  });

  it("surfaces a conflicting PR — the state that used to be invisible (LV-07)", () => {
    expect(
      reviewRowSub({
        ...base,
        pr: { number: 103, state: "review", mergeable: "conflicting" },
      }),
    ).toContain("conflicts with the base branch");
  });

  it("R17-1: an open PR whose head drifted ahead of the review warns it merges unreviewed", () => {
    const sub = reviewRowSub({
      ...base,
      pr: { number: 130, state: "review", revisionDrift: { headSha: "a".repeat(40), authored: 2, baseRefresh: null } },
    });
    // Ruling 132: the canonical sentence, verbatim.
    expect(sub).toContain("2 authored commits since review merge unreviewed");
  });

  it("R17-1: a conflicting PR still takes precedence over the drift note", () => {
    // conflicting is a harder blocker; it is named first.
    expect(
      reviewRowSub({
        ...base,
        pr: {
          number: 130,
          state: "review",
          mergeable: "conflicting",
          revisionDrift: { headSha: "b".repeat(40), authored: 1, baseRefresh: null },
        },
      }),
    ).toContain("conflicts with the base branch");
  });

  it("a merged PR reads as merged, whatever the newest event says", () => {
    expect(
      reviewRowSub({
        ...base,
        pr: { number: 311, state: "merged" },
        goalEditPending: false,
        latestEventText: "**Transition request:** move on",
      }),
    ).toContain("is merged on GitHub");
  });

  it("the block reason still outranks everything (F10-11)", () => {
    expect(
      reviewRowSub({
        ...base,
        pr: { number: 103, state: "review" },
        blockReason: "Waiting on 1 required reviewer approval of the current revision.",
      }),
    ).toBe("Waiting on 1 required reviewer approval of the current revision.");
  });
});

/**
 * R16-3 (owner ruling 2026-08-04) — terminal GitHub facts outrank process
 * gates, and force-accept is withheld while the PR is closed.
 */
describe("reviewRowSub terminal GitHub facts (R16-3)", () => {
  const closedNoVerdict: ReviewRowView = {
    ...base,
    waiting: "human",
    validation: "changed",
    pr: { number: 124, state: "closed" },
    blockReason:
      "VIB-1's delivered revision has no approving verdict yet — run a review for a verdict, or an admin can force-accept.",
  };

  it("a CLOSED PR is named over the verdict gate, and never offers force-accept", () => {
    // Live (H10): a delivered task whose PR had been closed unmerged carried a
    // correct "PR #124 closed — choose a recovery path" packet while this queue
    // told the same human to run a review or have an admin force-accept. Both
    // sentences were true-ish; only one is the path, and the task page already
    // ranks them the other way (acceptanceRefusalReason).
    const sub = reviewRowSub(closedNoVerdict);
    expect(sub).toBe(
      "PR #124 was closed on GitHub without merging. Rework and reopen it, or archive the task.",
    );
    expect(sub).not.toContain("force-accept");
    expect(sub).not.toContain("approving verdict");
  });

  it("an OPEN PR with the same gate keeps the process-gate copy verbatim", () => {
    // The ruling reorders exactly one case. Nothing about an open PR changed:
    // running a review IS the path there, and force-accept is still offered on
    // the task page, so the queue must keep saying so.
    expect(reviewRowSub({ ...closedNoVerdict, pr: { number: 124, state: "review" } })).toBe(
      closedNoVerdict.blockReason,
    );
  });

  it("a MERGED PR does not jump the gate — it is not a refusal", () => {
    // `merged` is reachable (the poller records a merge performed on GitHub)
    // but it is not terminal for acceptance: the task page still refuses under
    // the verdict gate and still offers force-accept, so "accept the completion
    // to close the task" would be the lie here.
    const sub = reviewRowSub({ ...closedNoVerdict, pr: { number: 124, state: "merged" } });
    expect(sub).toBe(closedNoVerdict.blockReason);
    expect(sub).not.toContain("accept the completion");
  });

  it("a closed PR with NO block reason reads the same — one sentence, one source", () => {
    expect(reviewRowSub({ ...closedNoVerdict, blockReason: null })).toBe(
      "PR #124 was closed on GitHub without merging. Rework and reopen it, or archive the task.",
    );
  });

  it("the closed fact also outranks a pending packet header", () => {
    // The recovery packet IS the path (R16-3), but the row has one line: the
    // fact that makes the packet necessary is what a triage list must show.
    expect(
      reviewRowSub({
        ...closedNoVerdict,
        packet: { kind: "Blocked decision", title: "Pick a recovery path" },
      }),
    ).toContain("closed on GitHub without merging");
  });
});

describe("ruling 138: reviewRowSub on a decided edit_goal packet", () => {
  it("says a goal edit is owed instead of re-offering the packet", () => {
    // Canary: drop the `goalEditPending` branch.
    const decided: ReviewRowView = {
      ...base,
      key: "VIB-9",
      waiting: "human",
      packet: { kind: "Blocked decision", title: "Scope needed" },
      goalEditPending: true,
    };
    expect(reviewRowSub(decided)).toBe("Goal edit pending: save the edited goal to clear the decision packet.");
    expect(reviewRowSub({ ...decided, goalEditPending: false })).toBe("Blocked decision: Scope needed");
  });
});

/**
 * U35-5 (pass 35): a row listed from BEFORE the acceptance boundary (an open
 * review PR, or a required reviewer's verdict outstanding on the current
 * revision) describes where it is and what the verdict state is, instead of
 * the boundary sentences that assume the task sits at the review stage.
 * Canary: drop the `!t.atAcceptanceBoundary` arm in `reviewRowSub` and every case
 * below falls through to the block reason / PR / placeholder sentences.
 */
describe("U35-5: reviewRowSub for review work before the boundary", () => {
  const atValidation: ReviewRowView = {
    ...base,
    stageName: "Validation",
    atAcceptanceBoundary: false,
    pr: { number: 8, state: "review" },
    validation: "changed",
    blockReason: "Waiting on 1 required reviewer approval of the current revision.",
  };

  it.each<[ReviewRowView["validation"], string]>([
    ["changed", "awaiting verdict"],
    ["failing", "changes requested"],
    // The verdict landed and the PR is still open.
    ["healthy", "approved"],
  ])("names the stage, the PR and the verdict (%s → %s), outranking the boundary block reason", (validation, verdict) => {
    expect(reviewRowSub({ ...atValidation, validation })).toBe(
      `Review in progress at Validation · PR #8 · ${verdict}`,
    );
  });

  it("drops the PR segment without a PR and the verdict segment without a review subject", () => {
    expect(
      reviewRowSub({ ...atValidation, stageName: "In Progress", pr: null, validation: "failing" }),
    ).toBe("Review in progress at In Progress · changes requested");
    expect(
      reviewRowSub({ ...atValidation, stageName: "Design", validation: "none", blockReason: null }),
    ).toBe("Review in progress at Design · PR #8");
  });

  it("a closed PR is still the terminal fact, before the boundary too (R16-3)", () => {
    expect(reviewRowSub({ ...atValidation, pr: { number: 8, state: "closed" } })).toBe(
      "PR #8 was closed on GitHub without merging. Rework and reopen it, or archive the task.",
    );
  });

  it("a row AT the boundary keeps the boundary sentences", () => {
    expect(reviewRowSub({ ...atValidation, stageName: "Review", atAcceptanceBoundary: true })).toBe(
      "Waiting on 1 required reviewer approval of the current revision.",
    );
  });

  it("a live PR fact outranks the in-progress sentence, and the stage still says where", () => {
    // Ruling 135 names the review row subline as a consumer of the unpushed
    // revision; ruling 132 the drift sentence; P14-LV-07 the conflict. These
    // rows are exactly where they fire (rule (b) admits any non-terminal task
    // with an open PR), and nothing else on the row renders them.
    // CANARY: rank `actionablePrSub` below the "Review in progress" sentence
    // again in `reviewInProgressSub` — all three read "· PR #8 · awaiting
    // verdict" and the person is never told what to do.
    expect(
      reviewRowSub({
        ...atValidation,
        pr: {
          number: 8,
          state: "review",
          headSha: "b".repeat(40),
          unpushedRevision: {
            revisionSha: "385047c" + "0".repeat(33),
            prHeadSha: "b".repeat(40),
            relation: "behind",
          },
        },
      }),
    ).toBe(
      "Review in progress at Validation · PR #8 does not carry the delivered revision 385047c. Deliver the branch to push it.",
    );
    expect(
      reviewRowSub({
        ...atValidation,
        pr: { number: 8, state: "review", mergeable: "conflicting" },
      }),
    ).toBe(
      "Review in progress at Validation · PR #8 conflicts with the base branch. GitHub can't merge it until the base is merged INTO the branch (not rebased).",
    );
    expect(
      reviewRowSub({
        ...atValidation,
        pr: {
          number: 8,
          state: "review",
          revisionDrift: { headSha: "c".repeat(40), authored: 2, baseRefresh: null },
        },
      }),
    ).toBe(
      "Review in progress at Validation · PR #8 is open. 2 authored commits since review merge unreviewed.",
    );
  });
});
