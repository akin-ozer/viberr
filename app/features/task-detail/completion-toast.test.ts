import { describe, expect, it } from "vitest";

import { completionToast, terminalStageNameFor } from "./completion-toast";

const STAGES = [
  { id: "triage", name: "Triage" },
  { id: "impl", name: "Building" },
  { id: "review", name: "Review" },
  { id: "done", name: "Shipped" },
];
const WORKFLOW = [
  { from: "triage", to: "impl" },
  { from: "impl", to: "review" },
  { from: "review", to: "done" },
];

/**
 * U36-9 (pass 36): the completion toasts name the terminal stage as the board
 * calls it. Canary: put the literal "Done" back into either sentence.
 */
describe("U36-9: completion toasts name the board's terminal stage", () => {
  it("resolves the terminal stage from the workflow graph, by its display name", () => {
    expect(terminalStageNameFor({ stages: STAGES, workflow: WORKFLOW })).toBe("Shipped");
    // A board with no workflow falls back to the last column.
    expect(terminalStageNameFor({ stages: STAGES })).toBe("Shipped");
    expect(terminalStageNameFor(null)).toBe("Done");
  });

  it("the accepted and force-accepted toasts carry that name, never the literal", () => {
    expect(completionToast("accepted", "VIB-9", "Shipped")).toBe(
      "Completion accepted · VIB-9 moved to Shipped",
    );
    expect(completionToast("forced", "VIB-9", "Shipped")).toBe(
      "Force-accepted VIB-9 · moved to Shipped (review gate overridden)",
    );
  });
});
