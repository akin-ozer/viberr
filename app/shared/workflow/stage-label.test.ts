import { describe, expect, it } from "vitest";
import { stageLabel } from "./stage-label";
import { CUSTOM_3_STAGE_BOARD } from "../../../test-support/custom-board";

describe("stageLabel (ruling 291)", () => {
  it("renders the stage's name, or 'unknown stage' for a reference that resolves to none", () => {
    const stages = CUSTOM_3_STAGE_BOARD.stages;
    expect(stageLabel(stages.find((s) => s.id === "doing"))).toBe("In progress");
    // A renamed/removed stage id: the words, never the raw id.
    expect(stageLabel(stages.find((s) => s.id === "gone"))).toBe("unknown stage");
    expect(stageLabel(null)).toBe("unknown stage");
  });
});
