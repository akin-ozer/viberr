import { describe, expect, it } from "vitest";
import { describeRevisionDrift } from "~/shared/revision-drift";
import { reviewRowSub, type ReviewRowView } from "./review-helpers";

const base: ReviewRowView = {
  key: "VIB-1",
  title: "t",
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
    ).toContain("Transition request:");
  });

  it("does NOT claim 'agent working' on a human-waiting row with no packet/event (R8-3)", () => {
    const sub = reviewRowSub({ ...base, waiting: "human" });
    expect(sub).not.toContain("Agent working");
    expect(sub).toContain("Needs a human decision");
  });

  it("keeps the agent-working fallback for a genuinely agent-waiting row", () => {
    expect(reviewRowSub({ ...base, waiting: "agent" })).toContain("Agent working");
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

  it("states a genuinely closed PR and points at the two real escapes", () => {
    const sub = reviewRowSub({ ...base, pr: { number: 103, state: "closed" } });
    expect(sub).toContain("closed on GitHub without merging");
    expect(sub).toContain("archive the task");
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
    const base = {
      key: "VIB-9",
      title: "t",
      priority: "normal" as const,
      labels: [],
      dueDate: null,
      waiting: "human" as const,
      packet: { kind: "Blocked decision", title: "Scope needed" },
      goalEditPending: true,
      latestEventText: null,
      pr: null,
      validation: "none" as const,
      blockReason: null,
      lastActivityAt: null,
      quiet: false,
      continuity: null,
    };
    expect(reviewRowSub(base)).toBe("Goal edit pending: save the edited goal to clear the decision packet.");
    expect(reviewRowSub({ ...base, goalEditPending: false })).toBe("Blocked decision: Scope needed");
  });
});
