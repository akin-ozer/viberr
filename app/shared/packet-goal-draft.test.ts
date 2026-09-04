import { describe, expect, it } from "vitest";
import { goalDraftForOption } from "./packet-goal-draft";

/**
 * Ruling 138 (pass 34, U34-10): the ONE composition of the goal editor's
 * prefill. An explicit `goalDraft` wins; without one the title and detail are
 * the draft (F17-L3), verbatim.
 *
 * Canary: swap the precedence (prefer `t + d` over `goalDraft`) and the first
 * case fails.
 */
describe("goalDraftForOption", () => {
  it("prefers the option's explicit goalDraft, trimmed", () => {
    expect(
      goalDraftForOption({
        t: "Confirming opens the goal editor: replace the goal",
        d: "I deliver straight after.",
        goalDraft: "  Deliverable: the search page.\n\nAcceptance: results render.  ",
      }),
    ).toBe("Deliverable: the search page.\n\nAcceptance: results render.");
  });

  it("falls back to title + detail verbatim when no draft is given", () => {
    expect(goalDraftForOption({ t: "Rewrite the goal", d: "to match search.md" })).toBe(
      "Rewrite the goal\n\nto match search.md",
    );
    expect(goalDraftForOption({ t: "Rewrite the goal", d: "   " })).toBe("Rewrite the goal");
    expect(goalDraftForOption({ t: "Rewrite the goal" })).toBe("Rewrite the goal");
  });

  it("treats a blank goalDraft as absent", () => {
    expect(goalDraftForOption({ t: "T", d: "D", goalDraft: "   " })).toBe("T\n\nD");
    expect(goalDraftForOption({ t: "T", d: "D", goalDraft: null })).toBe("T\n\nD");
  });
});
