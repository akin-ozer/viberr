import { describe, expect, it } from "vitest";
import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import {
  deriveReadiness,
  isAcceptedDisplayState,
} from "./readiness-policy.server";

const info: FileDiagnostic = { severity: "info", code: "x", message: "m" };
const warning: FileDiagnostic = { severity: "warning", code: "x", message: "m" };
const error: FileDiagnostic = { severity: "error", code: "x", message: "m" };
const hardStop: FileDiagnostic = {
  severity: "error",
  code: "x",
  message: "m",
  hardStop: true,
};

describe("deriveReadiness matrix", () => {
  it.each([
    // [stored, diagnostics, expected, downgraded]
    ["ready", [], "ready", false],
    ["ready", [info], "ready", false],
    ["ready", [warning], "input_required", true],
    ["ready", [error], "inconsistency_risk_detected", true],
    ["ready", [warning, error], "inconsistency_risk_detected", true],
    ["ready", [hardStop], "blocked", true],
    ["input_required", [], "input_required", false],
    ["input_required", [warning], "input_required", false], // floor == stored
    ["input_required", [error], "inconsistency_risk_detected", true],
    ["inconsistency_risk_detected", [warning], "inconsistency_risk_detected", false],
    ["inconsistency_risk_detected", [hardStop], "blocked", true],
    ["blocked", [], "blocked", false], // derivation never improves
    ["blocked", [info], "blocked", false],
    ["blocked", [error], "blocked", false],
  ] as const)(
    "stored=%s diags=%j → %s (downgraded=%s)",
    (stored, diagnostics, expected, downgraded) => {
      const result = deriveReadiness({
        storedReadiness: stored,
        diagnostics: [...diagnostics],
      });
      expect(result.readiness).toBe(expected);
      expect(result.downgraded).toBe(downgraded);
    },
  );

  it("missing stored readiness bases on `ready` (the missing-field warning floors it)", () => {
    const result = deriveReadiness({
      storedReadiness: null,
      diagnostics: [warning],
    });
    expect(result.readiness).toBe("input_required");
  });

  it("missing stored readiness with clean diagnostics → ready", () => {
    const result = deriveReadiness({ storedReadiness: null, diagnostics: [] });
    expect(result.readiness).toBe("ready");
  });
});

describe("isAcceptedDisplayState", () => {
  const stageIds = ["triage", "ready", "impl", "review", "done"];
  it("true only for the final stage", () => {
    expect(isAcceptedDisplayState({ stage: "done", stageIds })).toBe(true);
    expect(isAcceptedDisplayState({ stage: "review", stageIds })).toBe(false);
    expect(isAcceptedDisplayState({ stage: "triage", stageIds })).toBe(false);
  });
  it("falls back to literal 'done' when the stage list is unknown", () => {
    expect(isAcceptedDisplayState({ stage: "done", stageIds: [] })).toBe(true);
    expect(isAcceptedDisplayState({ stage: "impl", stageIds: [] })).toBe(false);
  });
});
