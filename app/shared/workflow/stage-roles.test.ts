import { describe, expect, it } from "vitest";
import {
  humanGatesPreWorkAdvance,
  isTerminalStage,
  resolveStageRoles,
} from "./stage-roles";
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

describe("humanGatesPreWorkAdvance (R15-9)", () => {
  const stages = [
    { id: "triage" },
    { id: "ready" },
    { id: "impl" },
    { id: "review" },
    { id: "done" },
  ];
  const wf = (
    ...boundaries: ("auto" | "approval" | "human")[]
  ) => [
    { to: "ready", boundary: boundaries[0]! },
    { to: "impl", boundary: boundaries[1]! },
    { to: "review", boundary: boundaries[2]! },
    // review -> done is human-locked in EVERY preset, so it carries no signal.
    { to: "done", boundary: "human" as const },
  ];

  it("is true only when NO pre-terminal boundary advances automatically", () => {
    // The `strict` preset's signature: presetWorkflow rewrites every pre-terminal
    // `auto` boundary to `approval`. The preset itself is never stored, so this
    // graph shape is the only durable evidence of it — and unlike a stored field
    // it is already true of projects that predate the capability (F15-20's shape).
    expect(humanGatesPreWorkAdvance(stages, wf("approval", "approval", "approval"))).toBe(true);
    expect(humanGatesPreWorkAdvance(stages, wf("auto", "approval", "approval"))).toBe(false);
    expect(humanGatesPreWorkAdvance(stages, wf("auto", "auto", "approval"))).toBe(false);
  });

  it("ignores the terminal edge, which is human-locked under every preset", () => {
    // A board whose ONLY boundary is review -> done must not read as strict just
    // because that one edge is human — it is human for everyone.
    expect(
      humanGatesPreWorkAdvance(stages, [{ to: "done", boundary: "human" }]),
    ).toBe(false);
  });

  it("a workflow with nothing to gate is not strict", () => {
    expect(humanGatesPreWorkAdvance(stages, [])).toBe(false);
    expect(humanGatesPreWorkAdvance([], [])).toBe(false);
  });
});
