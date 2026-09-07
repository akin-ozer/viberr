import { describe, expect, it } from "vitest";
import {
  misdirectedOptionPromise,
  misdirectedPromiseRefusal,
  moveStageTarget,
  type PacketStage,
} from "./packet-options";

/**
 * Ruling 164 (pass 35, F35-14) — the classifier behind the authoring guard.
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

describe("ruling 164: an option title is a promise the resolution keeps", () => {
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

  it("leaves the ruling-163 rework redirect alone: its resolution really does return the task", () => {
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

describe("ruling 164: a move_stage option names a stage the resolution can move to", () => {
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
});
