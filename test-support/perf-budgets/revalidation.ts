import type { PerfBudgetTable } from "../perf-verdict";

/** Ruling 454 ratchet ceilings: loaders re-run per navigation, action and live event. */
export const REVALIDATION_BUDGETS: PerfBudgetTable = {};
