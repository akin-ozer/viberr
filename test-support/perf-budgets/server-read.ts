import type { PerfBudgetTable } from "../perf-verdict";

/** Ruling 454 ratchet ceilings: server read path (file parses, auth, SQL per request). */
export const SERVER_READ_BUDGETS: PerfBudgetTable = {};
