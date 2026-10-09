import { describe, expect, it } from "vitest";
import {
  misdirectedOptionPromise,
  misdirectedPromiseRefusal,
  moveStagePromiseMismatch,
  moveStageTarget,
  type PacketStage,
} from "./packet-options";

/**
 * Ruling 131 (pass 35, F35-14) — the classifier behind the authoring guard.
 *
 * The two live options it exists for are asserted verbatim (KNC-3's custom
 * force-accept title, KNC-16's redirect stage move), together with the
 * false-positive canaries that decide whether the guard is usable at all: the
 * stock send-back options ship on every default packet, and a guard that
 * refused them would take the operator's ordinary vocabulary away.
 */
const STAGES: PacketStage[] = [
  { id: "triage", name: "Triage" },
  { id: "impl", name: "In Progress" },
  { id: "validation", name: "Validation" },
  { id: "review", name: "Review" },
  { id: "merge", name: "Merge" },
  { id: "done", name: "Done" },
];

describe("ruling 131: an option title is a promise the resolution keeps", () => {
  it("reads KNC-3's custom force-accept title as a force_accept promise", () => {
    const promise = misdirectedOptionPromise(
      { kind: "custom", title: "Force-accept as admin without a fresh verdict" },
      STAGES,
    );
    expect(promise).toEqual({ act: "force_accept" });
    const refusal = misdirectedPromiseRefusal(
      promise!,
      { kind: "custom", title: "Force-accept as admin without a fresh verdict" },
      "KNC-3",
    );
    expect(refusal).toContain("promise the resolution keeps");
    expect(refusal).toContain("'force_accept'");
  });

  it("reads KNC-16's redirect stage move as a move_stage promise, and names the stage id", () => {
    const option = {
      kind: "redirect" as const,
      title: "Move KNC-16 back to Review so the Reviewer can verdict 701b5b3",
    };
    const promise = misdirectedOptionPromise(option, STAGES);
    expect(promise).toEqual({ act: "move_stage", stage: { id: "review", name: "Review" } });
    const refusal = misdirectedPromiseRefusal(promise!, option, "KNC-16");
    expect(refusal).toContain("'move_stage'");
    expect(refusal).toContain("toStage: 'review'");
  });

  it("reads a profile edit offered as an option, and names no kind for it", () => {
    const option = {
      kind: "custom" as const,
      title: "Add Merge to the two reviewer profiles",
      detail: "The product's own remedy for the eligibility gap.",
    };
    const promise = misdirectedOptionPromise(option, STAGES);
    expect(promise).toEqual({ act: "agent_profile" });
    const refusal = misdirectedPromiseRefusal(promise!, option, "KNC-20");
    expect(refusal).toContain("Agents");
    expect(refusal).not.toContain("Use kind");
  });

  it("leaves the stock send-back options alone (they promise a send-back and do one)", () => {
    for (const option of [
      { kind: "request_edit" as const, title: "Send back to the specialist for changes" },
      { kind: "redirect" as const, title: "Reassign or redirect the work" },
      {
        kind: "redirect" as const,
        title: "Redirect the developer",
        detail: "Ask them to resolve the merge conflict on the branch and report back.",
      },
      { kind: "custom" as const, title: "Answer in my own words" },
    ]) {
      expect(misdirectedOptionPromise(option, STAGES)).toBeNull();
    }
  });

  it("leaves the delivery idioms alone: a redirect may say where the work is headed", () => {
    // Pass-35 cluster review: `send` and `advance` were movement verbs, so the
    // guard read the ordinary redirect ("have the developer send the fix to
    // review") as a promise to move the card and prescribed `move_stage` —
    // which moves the card and builds nothing. A redirect that asks an agent to
    // work and let the delivery carry it onward promises nothing the resolution
    // cannot do. Canary: put `send|sends|advance|advances` back in MOVE_VERBS.
    for (const title of [
      "Have the developer send the fix to review",
      "Ask the Developer to push the fix and send it to review",
      "Send the branch to review once the tests pass",
      "Advance the work to review after the fix",
    ]) {
      expect(misdirectedOptionPromise({ kind: "redirect", title }, STAGES)).toBeNull();
    }
    // The send-back phrasings that DO promise the move still land: the bare
    // "back to <stage>" alternative does not need a verb at all.
    expect(
      misdirectedOptionPromise(
        { kind: "redirect", title: "Send KNC-16 back to Review for the re-verdict" },
        STAGES,
      ),
    ).toEqual({ act: "move_stage", stage: { id: "review", name: "Review" } });
  });

  it("leaves the ruling-90 rework redirect alone: its resolution really does return the task", () => {
    // The branch-conflict packet's own option (update-branch-operator.server):
    // `rework: true` makes `resolvePacket` move the task to the review stage in
    // the same write, so "The task returns to Review" is a promise it keeps.
    expect(
      misdirectedOptionPromise(
        {
          kind: "redirect",
          title: "Have the Docs Engineer resolve the conflict",
          detail:
            "Its workspace already has origin/main fetched. The task returns to Review for the re-verdict.",
          rework: true,
        },
        STAGES,
      ),
    ).toBeNull();
    // Without the marker the same words promise a move nothing performs.
    expect(
      misdirectedOptionPromise(
        {
          kind: "redirect",
          title: "Have the Docs Engineer resolve the conflict",
          detail: "The task returns to Review for the re-verdict.",
        },
        STAGES,
      ),
    ).toEqual({ act: "move_stage", stage: { id: "review", name: "Review" } });
  });

  it("reads nothing into an option whose own kind performs the act", () => {
    expect(
      misdirectedOptionPromise(
        { kind: "force_accept", title: "Force-accept without a fresh verdict" },
        STAGES,
      ),
    ).toBeNull();
    expect(
      misdirectedOptionPromise(
        { kind: "move_stage", title: "Move KNC-16 back to Review" },
        STAGES,
      ),
    ).toBeNull();
  });
});

describe("ruling 131: a move_stage option names a stage the resolution can move to", () => {
  it("resolves the named stage", () => {
    const target = moveStageTarget({ toStage: "review" }, STAGES, "KNC-16");
    expect(target).toEqual({ ok: true, stage: { id: "review", name: "Review" } });
  });

  it("refuses no stage, an unknown stage and the terminal stage", () => {
    const none = moveStageTarget({}, STAGES, "KNC-16");
    expect(none.ok).toBe(false);
    expect(none.ok ? "" : none.refusal).toContain("has to name the stage");

    const unknown = moveStageTarget({ toStage: "nowhere" }, STAGES, "KNC-16");
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? "" : unknown.refusal).toContain("not a stage of this project");

    const terminal = moveStageTarget({ toStage: "done" }, STAGES, "KNC-16");
    expect(terminal.ok).toBe(false);
    expect(terminal.ok ? "" : terminal.refusal).toContain("accepts its completion");
    expect(terminal.ok ? "" : terminal.refusal).toContain("force_accept");
  });

  /**
   * Pass-35 cluster review: `move_stage` was exempted from the promise guard on
   * the grounds that it "describes itself". It does not — it carries a
   * free-text title AND a separate `toStage`, the card renders only the words,
   * and the resolution reads only the id.
   */
  it("refuses a move_stage whose words name a stage other than the one it moves to", () => {
    const refusal = moveStagePromiseMismatch(
      { title: "Move VIB-1 back to Review so the reviewer can verdict" },
      { id: "triage", name: "Triage" },
      STAGES,
      "VIB-1",
    );
    expect(refusal).toContain("says Review");
    expect(refusal).toContain("toStage is 'triage'");
    expect(refusal).toContain("move VIB-1 to Triage");
  });

  it("leaves a move_stage whose words name its own target, or name no stage at all", () => {
    expect(
      moveStagePromiseMismatch(
        { title: "Move VIB-1 back to Review so the reviewer can verdict" },
        { id: "review", name: "Review" },
        STAGES,
        "VIB-1",
      ),
    ).toBeNull();
    expect(
      moveStagePromiseMismatch(
        {
          title: "Send the work back so it can be re-done",
          detail: "The reviewer asked for changes.",
        },
        { id: "impl", name: "In Progress" },
        STAGES,
        "VIB-1",
      ),
    ).toBeNull();
  });
});
