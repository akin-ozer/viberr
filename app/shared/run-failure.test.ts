import { describe, expect, it } from "vitest";
import {
  formatUsd,
  RUN_DID_NOT_COMPLETE_RE,
  runDidNotCompleteLead,
} from "./run-failure";

describe("formatUsd (ruling 159)", () => {
  it("prints cents from a dollar up", () => {
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("below a dollar keeps up to four decimals, never fewer than two, so a spend past a small cap never prints as the cap", () => {
    // The live canary: a $0.01 cap, $0.010638 spent, used to read "…after
    // spending $0.01".
    expect(formatUsd(0.010638)).toBe("$0.0106");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.123)).toBe("$0.123");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

/**
 * Ruling 155 (F39-24): the sentence and its matcher are one fact.
 *
 * The operator's snapshot finds a standing report by matching the failure event
 * this lead writes. If the two drift, the operator silently stops being told
 * that a report is sitting under a failure note — the exact defect the ruling
 * exists to close, back again and invisible.
 */
describe("ruling 155: the run-failure lead and its matcher", () => {
  it("matches what the builder writes, for every role the product uses", () => {
    for (const role of ["Implementation", "Review & validation", "primary", "supporting"]) {
      for (const label of ["agent", "operator"]) {
        const lead = runDidNotCompleteLead(role, label);
        // CANARY: change either side alone and this goes red.
        expect(RUN_DID_NOT_COMPLETE_RE.test(`${lead}. Codex could not be reached.`), role).toBe(true);
        expect(RUN_DID_NOT_COMPLETE_RE.test(`${lead}: it hit its turn cap.`), role).toBe(true);
      }
    }
  });

  it("does not match another kind of blocked event", () => {
    for (const text of [
      "I cannot reach the repository and have stopped.",
      "Blocked: Work stalled: pick a recovery path.",
      "The review did not complete because no verdict was recorded.",
      // Not at the start of the text: a report that merely mentions the phrase.
      "My previous run did not complete: I am continuing from where it stopped.",
    ]) {
      expect(RUN_DID_NOT_COMPLETE_RE.test(text), text).toBe(false);
    }
  });
});
