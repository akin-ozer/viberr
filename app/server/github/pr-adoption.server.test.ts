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

/** A sha that is not the delivered revision: a stranger's head. */
const STRANGER = "93435dfffeeeddccbbaa00998877665544332211";

describe("decidePrAdoption", () => {
  it.each<[string, Parameters<typeof decidePrAdoption>[0], ReturnType<typeof decidePrAdoption>]>([
    // Non-review states fail closed, and merged and closed refuse DIFFERENTLY
    // (F17-L4): a merged PR's collision is a stale name, a closed one's a
    // history hazard.
    [
      "refuses a merged PR with refusal 'merged' (stale name, no history hazard)",
      { state: "merged", prHeadSha: STRANGER, revisionHeadSha: REVISION },
      { adopt: false, refusal: "merged" },
    ],
    [
      "refuses a closed-unmerged PR with the DIFFERENT refusal 'closed'",
      { state: "closed", prHeadSha: STRANGER, revisionHeadSha: REVISION },
      { adopt: false, refusal: "closed" },
    ],
    [
      // "accepted" (human-accepted, real merge pending) is not "merged", so it
      // falls into the non-merged branch.
      "refuses the Viberr-only 'accepted' state through the 'closed' arm",
      { state: "accepted", prHeadSha: REVISION, revisionHeadSha: REVISION },
      { adopt: false, refusal: "closed" },
    ],
    [
      // Identity of the head does NOT rescue a non-open PR: state gates first.
      "refuses a merged PR even when its head equals the delivered revision",
      { state: "merged", prHeadSha: REVISION, revisionHeadSha: REVISION },
      { adopt: false, refusal: "merged" },
    ],
    [
      "refuses with 'no_revision' when the task has delivered nothing (null)",
      { state: "review", prHeadSha: REVISION, revisionHeadSha: null },
      { adopt: false, refusal: "no_revision" },
    ],
    [
      "refuses with 'no_revision' when the delivered revision is undefined",
      { state: "review", prHeadSha: REVISION, revisionHeadSha: undefined },
      { adopt: false, refusal: "no_revision" },
    ],
    [
      "refuses with 'no_revision' when the delivered revision is whitespace only",
      { state: "review", prHeadSha: REVISION, revisionHeadSha: "   " },
      { adopt: false, refusal: "no_revision" },
    ],
    [
      "refuses with 'head_unknown' when the PR head could not be read (null, fail closed)",
      { state: "review", prHeadSha: null, revisionHeadSha: REVISION },
      { adopt: false, refusal: "head_unknown" },
    ],
    [
      "refuses with 'head_unknown' when the PR head is undefined",
      { state: "review", prHeadSha: undefined, revisionHeadSha: REVISION },
      { adopt: false, refusal: "head_unknown" },
    ],
    [
      "refuses with 'head_unknown' when the PR head is whitespace only",
      { state: "review", prHeadSha: "  ", revisionHeadSha: REVISION },
      { adopt: false, refusal: "head_unknown" },
    ],
    [
      // The exact H8 shape: an OPEN readable PR whose head is a stranger commit.
      "refuses with 'head_mismatch' when a readable head is not the delivered revision",
      { state: "review", prHeadSha: STRANGER, revisionHeadSha: REVISION },
      { adopt: false, refusal: "head_mismatch" },
    ],
    [
      "checks revision presence BEFORE head presence (no_revision wins when both are empty)",
      { state: "review", prHeadSha: null, revisionHeadSha: null },
      { adopt: false, refusal: "no_revision" },
    ],
    [
      "adopts only when open and the head IS the delivered revision",
      { state: "review", prHeadSha: REVISION, revisionHeadSha: REVISION },
      { adopt: true },
    ],
    [
      // Padding must not block a legitimate identity match.
      "adopts after trimming surrounding whitespace on both shas",
      { state: "review", prHeadSha: `  ${REVISION}  `, revisionHeadSha: `\t${REVISION}\n` },
      { adopt: true },
    ],
  ])("%s", (_label, input, decision) => {
    expect(decidePrAdoption(input)).toEqual(decision);
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

  it("explains the post-allocation unowned PR AND the pre-ruling-228 reused key, and commits to neither", () => {
    // Origin one (ruling 233): an unowned OPEN PR that appeared on the
    // branch AFTER Viberr allocated the name. JC-8 hit exactly this at
    // 10:17:52Z and read a note blaming a reused task key it never had.
    expect(note).toMatch(/opened on `jc-8` after Viberr allocated the name to JC-8/);
    // Origin two: a branch recorded under a reused task key, before names took a
    // suffix (ruling 228).
    expect(note).toMatch(/JC-8's branch was recorded under a task key an older data root had already used/);
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
