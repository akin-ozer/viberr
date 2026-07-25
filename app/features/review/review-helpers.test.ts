import { describe, expect, it } from "vitest";
import { reviewRowSub, type ReviewRowView } from "./review-helpers";

const base: ReviewRowView = {
  key: "VIB-1",
  title: "t",
  waiting: "agent",
  packet: null,
  latestEventText: null,
  pr: null,
  validation: "none",
  blockReason: null,
};

describe("reviewRowSub", () => {
  it("prefers the packet header", () => {
    expect(
      reviewRowSub({ ...base, packet: { kind: "Completion report", title: "Accept?" } }),
    ).toBe("Completion report — Accept?");
  });

  it("falls back to the newest event text (markdown stripped)", () => {
    expect(
      reviewRowSub({ ...base, latestEventText: "**Transition request:** move on" }),
    ).toContain("Transition request:");
  });

  it("does NOT claim 'agent working' on a human-waiting row with no packet/event (R8-3)", () => {
    const sub = reviewRowSub({ ...base, waiting: "human" });
    expect(sub).not.toContain("Agent working");
    expect(sub).toContain("needs a human decision");
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

  it("surfaces a conflicting PR — the state that used to be invisible (LV-07)", () => {
    expect(
      reviewRowSub({
        ...base,
        pr: { number: 103, state: "review", mergeable: "conflicting" },
      }),
    ).toContain("conflicts with the base branch");
  });

  it("a merged PR reads as merged, whatever the newest event says", () => {
    expect(
      reviewRowSub({
        ...base,
        pr: { number: 311, state: "merged" },
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
