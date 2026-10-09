import { expect } from "vitest";
import { PERF_BUDGETS } from "./perf-budgets";
import { budgetVerdict } from "./perf-verdict";

/**
 * Ruling 11: asserts one measured figure against its ratchet ceiling
 * (`test-support/perf-budgets/`). Fails on a regression AND on an unrecorded
 * improvement; the failure message says which number to write.
 */
export function expectWithinBudget(id: string, measured: number): void {
  const verdict = budgetVerdict(id, measured, PERF_BUDGETS);
  expect(verdict.ok, verdict.message).toBe(true);
}
