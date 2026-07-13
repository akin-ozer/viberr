import { describe, expect, it } from "vitest";
import {
  resolveOperatorExecutionStatus,
  type OperatorExecutionStatusInput,
} from "./operator-execution-status";

describe("resolveOperatorExecutionStatus", () => {
  it.each<
    [string, OperatorExecutionStatusInput, string]
  >([
    ["active run", { runLifecycle: "running", dispatchState: "queued", engaged: true, configured: true }, "running"],
    ["active dispatch", { runLifecycle: "finished", dispatchState: "queued", engaged: true, configured: true }, "queued"],
    ["last run", { runLifecycle: "error", dispatchState: "interrupted", engaged: true, configured: true }, "failed"],
    ["last dispatch", { runLifecycle: null, dispatchState: "finished", engaged: true, configured: true }, "finished"],
    ["engaged", { runLifecycle: null, dispatchState: null, engaged: true, configured: true }, "engaged"],
    ["configured", { runLifecycle: null, dispatchState: null, engaged: false, configured: true }, "configured"],
    ["not configured", { runLifecycle: null, dispatchState: null, engaged: false, configured: false }, "not_configured"],
  ])("uses %s at its precedence level", (_label, input, expected) => {
    expect(resolveOperatorExecutionStatus(input)).toBe(expected);
  });
});
