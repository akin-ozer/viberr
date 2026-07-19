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
