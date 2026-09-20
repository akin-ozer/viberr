import { describe, expect, it } from "vitest";
import {
  isStageColor,
  nextStageColor,
  STAGE_COLORS,
  stageColorAt,
  stageColorSchema,
  TERMINAL_STAGE_COLOR,
} from "./stage-colors";

/* Ruling 364: the twenty presets are the whole vocabulary of a stage colour. */
describe("stage colour presets (ruling 364)", () => {
  it("is exactly twenty distinct lower-case names", () => {
    expect(STAGE_COLORS).toHaveLength(20);
    expect(new Set(STAGE_COLORS).size).toBe(20);
    for (const name of STAGE_COLORS) expect(name).toMatch(/^[a-z]+$/);
  });

  it("the schema and the guard take a preset and nothing else — not a hex, not a token, not a case variant", () => {
    expect(stageColorSchema.parse("amber")).toBe("amber");
    expect(isStageColor("slate")).toBe(true);
    for (const wrong of ["#7b61ff", "var(--muted)", "Slate", "AMBER", "", "goldenrod"]) {
      expect(stageColorSchema.safeParse(wrong).success, wrong).toBe(false);
      expect(isStageColor(wrong), wrong).toBe(false);
    }
  });

  it("the default walk starts neutral, keeps green for the terminal lane, and wraps", () => {
    expect(stageColorAt(0)).toBe("slate");
    expect(TERMINAL_STAGE_COLOR).toBe("green");
    expect(stageColorAt(20)).toBe(stageColorAt(0));
    // Twenty defaults cover the twenty presets, each once.
    expect(new Set(Array.from({ length: 20 }, (_, i) => stageColorAt(i))).size).toBe(20);
  });

  it("a new stage takes the first default no sibling wears, then wraps", () => {
    expect(nextStageColor([])).toBe("slate");
    expect(nextStageColor(["slate", "violet"])).toBe("blue");
    expect(nextStageColor(["blue"])).toBe("slate");
    expect(nextStageColor([...STAGE_COLORS])).toBe(stageColorAt(20));
  });
});
