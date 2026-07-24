import { describe, expect, it } from "vitest";
import { isTerminalStage, resolveStageRoles } from "./stage-roles";
import { CUSTOM_3_STAGE_BOARD } from "../../../test-support/custom-board";
import { GOVERNED_TEMPLATE } from "./templates";

describe("resolveStageRoles", () => {
  it("resolves the default 5-stage governed board from its workflow graph", () => {
    const roles = resolveStageRoles(
      GOVERNED_TEMPLATE.stages,
      GOVERNED_TEMPLATE.workflow,
    );
    expect(roles).toEqual({
      entryId: "triage",
      terminalId: "done",
      reviewId: "review",
      workId: "impl",
    });
  });

  // The 3-stage board is now a CUSTOM board fixture, not a shipped preset —
  // P13-AP-04 deleted the "Lightweight · 3 stages" template (its roster could
  // never be stage-eligible). Custom boards still exist, so role resolution on
  // non-default stage ids is still the thing under test.
  it("resolves a custom 3-stage board (no literal 'review'/'triage')", () => {
    const roles = resolveStageRoles(
      CUSTOM_3_STAGE_BOARD.stages,
      CUSTOM_3_STAGE_BOARD.workflow,
    );
    // entry=todo, terminal=done; review = the stage with an edge into done
    // (doing); work = the stage before review (todo, positional fallback).
    expect(roles.entryId).toBe("todo");
    expect(roles.terminalId).toBe("done");
    expect(roles.reviewId).toBe("doing");
    expect(roles.workId).toBe("todo");
  });

  it("resolves a custom board whose ids are none of the defaults", () => {
    const stages = [
      { id: "intake" },
      { id: "build" },
      { id: "qa" },
      { id: "ship" },
    ];
    const workflow = [
      { from: "intake", to: "build" },
      { from: "build", to: "qa" },
      { from: "qa", to: "ship" },
    ];
    const roles = resolveStageRoles(stages, workflow);
    expect(roles).toEqual({
      entryId: "intake",
      terminalId: "ship",
      reviewId: "qa",
      workId: "build",
    });
  });

  it("falls back to positional roles when the workflow graph is empty", () => {
    const stages = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const roles = resolveStageRoles(stages, []);
    expect(roles.entryId).toBe("a");
    expect(roles.terminalId).toBe("c");
    // review = positionally-before-terminal (b); work = before review (a).
    expect(roles.reviewId).toBe("b");
    expect(roles.workId).toBe("a");
  });

  it("handles degenerate single-stage and empty boards", () => {
    expect(resolveStageRoles([{ id: "only" }], [])).toEqual({
      entryId: "only",
      terminalId: "only",
      reviewId: null,
      workId: null,
    });
    expect(resolveStageRoles([], [])).toEqual({
      entryId: null,
      terminalId: null,
      reviewId: null,
      workId: null,
    });
  });

  it("isTerminalStage keys off position, not literal ids", () => {
    const stages = CUSTOM_3_STAGE_BOARD.stages;
    expect(isTerminalStage("done", stages)).toBe(true);
    expect(isTerminalStage("doing", stages)).toBe(false);
  });
});
