import { describe, expect, it } from "vitest";
import type { PrCacheState } from "./pr-linker.server";
import {
  decidePrAdoption,
  type PrAdoptionDecision,
} from "./pr-adoption.server";

/**
 * R16-1 (owner ruling 2026-08-04) codified as the pure decision table
 * `decidePrAdoption`. It is the fix for the H8 live incident where a fresh
 * VIB-4 wore merged stranger-PR #113's green badge and "checks 2/2" for work
 * (revision `80e9b2c`) that had never been pushed.
 *
 * The rule is IDENTITY, not containment: adopt a PR only when it is OPEN
 * ("review" in cache vocabulary) AND its head sha IS the task's delivered
 * revision. Every other arm fails closed with a NAMED refusal so the branch
 * collision reads as one problem, not a GitHub mystery.
 *
 * These assertions pin the exact refusal string on each arm. A flipped falsy
 * check (e.g. `if (head)` instead of `if (!head)`) that silently re-enabled
 * cross-instance adoption would change or drop one of these strings and fail
 * here.
 */

/** The delivered revision used across the review-state arms. */
const REVISION = "80e9b2c1122334455667788990011223344556677";

describe("decidePrAdoption non-review states (fail closed, F17-L4 split)", () => {
  it("refuses a merged PR with refusal 'merged' (stale name, no history hazard)", () => {
    const decision = decidePrAdoption({
      state: "merged",
      prHeadSha: "93435dfffeeeddccbbaa00998877665544332211",
      revisionHeadSha: REVISION,
    });
    expect(decision).toEqual({ adopt: false, refusal: "merged" });
  });

  it("refuses a closed-unmerged PR with the DIFFERENT refusal 'closed'", () => {
    const decision = decidePrAdoption({
      state: "closed",
      prHeadSha: "93435dfffeeeddccbbaa00998877665544332211",
      revisionHeadSha: REVISION,
    });
    expect(decision).toEqual({ adopt: false, refusal: "closed" });
  });

  it("keeps 'merged' and 'closed' as distinct refusals (the split matters)", () => {
    const merged = decidePrAdoption({
      state: "merged",
      prHeadSha: REVISION,
      revisionHeadSha: REVISION,
    });
    const closed = decidePrAdoption({
      state: "closed",
      prHeadSha: REVISION,
      revisionHeadSha: REVISION,
    });
    expect(merged).not.toEqual(closed);
  });

  it("treats the Viberr-only 'accepted' state as un-adoptable via the 'closed' arm", () => {
    // "accepted" (human-accepted, real merge pending) is not "merged", so it
    // falls into the non-merged branch and refuses as "closed".
    const decision = decidePrAdoption({
      state: "accepted",
      prHeadSha: REVISION,
      revisionHeadSha: REVISION,
    });
    expect(decision).toEqual({ adopt: false, refusal: "closed" });
  });

  it("refuses a merged PR even when its head equals the delivered revision", () => {
    // Identity of the head does NOT rescue a non-open PR: state gates first.
    const decision = decidePrAdoption({
      state: "merged",
      prHeadSha: REVISION,
      revisionHeadSha: REVISION,
    });
    expect(decision).toEqual({ adopt: false, refusal: "merged" });
  });
});

describe("decidePrAdoption review state (identity check)", () => {
  it("refuses with 'no_revision' when the task has delivered nothing (null)", () => {
    const decision = decidePrAdoption({
      state: "review",
      prHeadSha: REVISION,
      revisionHeadSha: null,
    });
    expect(decision).toEqual({ adopt: false, refusal: "no_revision" });
  });

  it("refuses with 'no_revision' when the delivered revision is undefined", () => {
    const decision = decidePrAdoption({
      state: "review",
      prHeadSha: REVISION,
      revisionHeadSha: undefined,
    });
    expect(decision).toEqual({ adopt: false, refusal: "no_revision" });
  });

  it("refuses with 'no_revision' when the delivered revision is whitespace only", () => {
    const decision = decidePrAdoption({
      state: "review",
      prHeadSha: REVISION,
      revisionHeadSha: "   ",
    });
    expect(decision).toEqual({ adopt: false, refusal: "no_revision" });
  });

  it("refuses with 'head_unknown' when the PR head could not be read (null, fail closed)", () => {
    const decision = decidePrAdoption({
      state: "review",
      prHeadSha: null,
      revisionHeadSha: REVISION,
    });
    expect(decision).toEqual({ adopt: false, refusal: "head_unknown" });
  });

  it("refuses with 'head_unknown' when the PR head is undefined", () => {
    const decision = decidePrAdoption({
      state: "review",
      prHeadSha: undefined,
      revisionHeadSha: REVISION,
    });
    expect(decision).toEqual({ adopt: false, refusal: "head_unknown" });
  });

  it("refuses with 'head_unknown' when the PR head is whitespace only", () => {
    const decision = decidePrAdoption({
      state: "review",
      prHeadSha: "  ",
      revisionHeadSha: REVISION,
    });
    expect(decision).toEqual({ adopt: false, refusal: "head_unknown" });
  });

  it("refuses with 'head_mismatch' when a readable head is not the delivered revision", () => {
    // The exact H8 shape: an OPEN readable PR whose head is a stranger commit.
    const decision = decidePrAdoption({
      state: "review",
      prHeadSha: "93435dfffeeeddccbbaa00998877665544332211",
      revisionHeadSha: REVISION,
    });
    expect(decision).toEqual({ adopt: false, refusal: "head_mismatch" });
  });

  it("adopts (adopt: true) only when open and the head IS the delivered revision", () => {
    const decision = decidePrAdoption({
      state: "review",
      prHeadSha: REVISION,
      revisionHeadSha: REVISION,
    });
    expect(decision).toEqual({ adopt: true });
    expect(decision.adopt).toBe(true);
  });

  it("adopts after trimming surrounding whitespace on both shas", () => {
    // head and revision are trimmed before comparison, so padding must not
    // block a legitimate identity match.
    const decision = decidePrAdoption({
      state: "review",
      prHeadSha: `  ${REVISION}  `,
      revisionHeadSha: `\t${REVISION}\n`,
    });
    expect(decision).toEqual({ adopt: true });
  });
});

describe("decidePrAdoption refusal-arm precedence", () => {
  it("checks revision presence BEFORE head presence (no_revision wins when both empty)", () => {
    const decision = decidePrAdoption({
      state: "review",
      prHeadSha: null,
      revisionHeadSha: null,
    });
    expect(decision).toEqual({ adopt: false, refusal: "no_revision" });
  });

  it("emits exactly one refusal string per non-adopting arm (no leaked adopt:true)", () => {
    const cases: { state: PrCacheState; head: string | null; rev: string | null }[] = [
      { state: "merged", head: REVISION, rev: REVISION },
      { state: "closed", head: REVISION, rev: REVISION },
      { state: "review", head: REVISION, rev: null },
      { state: "review", head: null, rev: REVISION },
      { state: "review", head: "deadbeef", rev: REVISION },
    ];
    for (const c of cases) {
      const decision: PrAdoptionDecision = decidePrAdoption({
        state: c.state,
        prHeadSha: c.head,
        revisionHeadSha: c.rev,
      });
      expect(decision.adopt).toBe(false);
      if (!decision.adopt) {
        expect(typeof decision.refusal).toBe("string");
      }
    }
  });
});
