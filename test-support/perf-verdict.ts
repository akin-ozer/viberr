/**
 * Ruling 454: the ratchet's one verdict, shared by the vitest helper
 * (`perf-ratchet.ts`) and `node scripts/measure-routes.mjs --check`. It has no
 * imports on purpose: Node strips the types and loads it straight from the
 * script.
 */

export type PerfJourney =
  | "fresh-load"
  | "task-open"
  | "live-run"
  | "board-live"
  | "compose-send"
  | "controller"
  | "server";

export interface PerfBudget {
  ceiling: number;
  unit: "bytes" | "count";
  journey: PerfJourney;
  /** The data and setup the measuring test uses, in words. */
  fixture: string;
  /**
   * How far below the ceiling a measurement may land before the ratchet asks
   * for the ceiling to be lowered. Defaults: 0 for counts, 0.05 for bytes.
   */
  slack?: number;
}

export type PerfBudgetTable = Record<string, PerfBudget>;

export interface BudgetVerdict {
  ok: boolean;
  message: string;
}

/** Judges one measurement against its ceiling, in both directions. */
export function budgetVerdict(
  id: string,
  measured: number,
  table: PerfBudgetTable,
): BudgetVerdict {
  const budget = table[id];
  if (!budget) {
    return { ok: false, message: `no perf budget named "${id}"` };
  }
  const slack = budget.slack ?? (budget.unit === "bytes" ? 0.05 : 0);
  const floor = Math.floor(budget.ceiling * (1 - slack));
  if (measured > budget.ceiling) {
    return {
      ok: false,
      message:
        `${id} regressed: measured ${measured} ${budget.unit}, ceiling ${budget.ceiling} ` +
        `(${budget.fixture}). Remove the extra work, or raise the ceiling in ` +
        `test-support/perf-budgets/ with the reason beside it.`,
    };
  }
  if (measured < floor) {
    return {
      ok: false,
      message:
        `${id} improved: measured ${measured} ${budget.unit}, below the ceiling ${budget.ceiling}. ` +
        `Lower the ceiling to ${measured} in test-support/perf-budgets/ so the win is kept.`,
    };
  }
  return { ok: true, message: `${id}: ${measured} of ${budget.ceiling} ${budget.unit}` };
}
