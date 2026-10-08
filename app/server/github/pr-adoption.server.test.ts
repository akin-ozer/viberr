import { describe, expect, it } from "vitest";
import { decidePrAdoption, prAdoptionRefusalNote } from "./pr-adoption.server";

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
  it.each([
    ["null (the task has delivered nothing)", null],
    ["undefined", undefined],
    ["whitespace only", "   "],
  ] as const)("refuses with 'no_revision' when the delivered revision is %s", (_label, revisionHeadSha) => {
    expect(decidePrAdoption({ state: "review", prHeadSha: REVISION, revisionHeadSha })).toEqual({
      adopt: false,
      refusal: "no_revision",
    });
  });

  it.each([
    ["null (it could not be read, fail closed)", null],
    ["undefined", undefined],
    ["whitespace only", "  "],
  ] as const)("refuses with 'head_unknown' when the PR head is %s", (_label, prHeadSha) => {
    expect(decidePrAdoption({ state: "review", prHeadSha, revisionHeadSha: REVISION })).toEqual({
      adopt: false,
      refusal: "head_unknown",
    });
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
});

describe("prAdoptionRefusalNote (pass 34, U34-6): names both collision origins, asserts neither", () => {
  const note = prAdoptionRefusalNote({
    refusal: "head_mismatch",
    taskKey: "JC-8",
    branch: "jc-8",
    prNumber: 41,
    revisionHeadSha: REVISION,
  });

  it("keeps the byte-identical opener the reconciler, the wake, PR open and their tests key on", () => {
    expect(
      note.startsWith("**Branch name collision:** GitHub already has PR #41 on branch `jc-8`, but it is NOT JC-8's review PR: "),
    ).toBe(true);
  });

  it("explains the post-allocation unowned PR AND the pre-ruling-122 reused key, and commits to neither", () => {
    // Origin one (ruling 122(d)): an unowned OPEN PR that appeared on the
    // branch AFTER Viberr allocated the name. JC-8 hit exactly this at
    // 10:17:52Z and read a note blaming a reused task key it never had.
    expect(note).toMatch(/opened on `jc-8` after Viberr allocated the name to JC-8/);
    // Origin two: a branch recorded before ruling 122 under a reused task key.
    expect(note).toMatch(/JC-8's branch was recorded before ruling 122 under a task key/);
    expect(note).toMatch(/keys restart at 1/);
    // Neither is asserted: the note says it cannot tell, and the old causal
    // paragraph ("This happens when a task key is reused … so this only
    // reaches a task whose branch was recorded before that") is gone.
    // CANARY: restore that paragraph and every line below fails.
    expect(note).toMatch(/Viberr cannot tell which from here/);
    expect(note).not.toMatch(/This happens when/);
    expect(note).not.toMatch(/only reaches a task/);
    expect(note).not.toMatch(/suffixed name instead/);
  });

  it("still carries the refusal cause and the one remedy", () => {
    expect(note).toContain(`its head is not JC-8's delivered revision (${REVISION.slice(0, 7)})`);
    expect(note).toContain("`resolve_remote_collision`");
    expect(note).toContain("deletes the stale remote branch `jc-8`");
  });
});
