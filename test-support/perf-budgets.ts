import { CONSOLE_BUDGETS } from "./perf-budgets/console";
import { CONTROLLER_BUDGETS } from "./perf-budgets/controller";
import { PAYLOAD_BUDGETS } from "./perf-budgets/payload";
import { RENDER_BUDGETS } from "./perf-budgets/render";
import { REVALIDATION_BUDGETS } from "./perf-budgets/revalidation";
import { SERVER_READ_BUDGETS } from "./perf-budgets/server-read";
import { WRITES_BUDGETS } from "./perf-budgets/writes";
import type { PerfBudgetTable } from "./perf-verdict";

/**
 * Ruling 11: the performance ratchet. Each entry is a DETERMINISTIC figure
 * (bytes shipped, SQL statements run, React renders or commits, loaders re-run)
 * measured on a named fixture by a co-located `*.perf.test.ts(x)` file, with a
 * ceiling it may never exceed. The ceiling only moves down: the verdict
 * (`perf-verdict.ts`) also fails when the measured figure drops below
 * `ceiling * (1 - slack)`, so an improvement has to be recorded by lowering
 * the ceiling in the same change (the failure message prints the number).
 * Raising a ceiling is allowed only as a visible edit to these files, with the
 * reason in the entry's comment.
 *
 * Wall-clock budgets are deliberately absent: this machine and CI are shared,
 * and a figure that swings with load cannot ratchet.
 *
 * The client bundle closures live in `perf-budgets/bundle.json`, which
 * `node scripts/measure-routes.mjs --check` reads after `npm run build`.
 * `app/shared/docs/perf-budgets-sync.test.ts` fails on a budget no perf test
 * measures, so a ceiling cannot outlive its measurement.
 *
 * Budgets are split by area so parallel changes append to different files.
 */

function merge(...tables: PerfBudgetTable[]): PerfBudgetTable {
  const out: PerfBudgetTable = {};
  for (const table of tables) {
    for (const [id, budget] of Object.entries(table)) {
      if (id in out) throw new Error(`perf budget "${id}" is defined twice`);
      out[id] = budget;
    }
  }
  return out;
}

export const PERF_BUDGETS: PerfBudgetTable = merge(
  SERVER_READ_BUDGETS,
  PAYLOAD_BUDGETS,
  WRITES_BUDGETS,
  REVALIDATION_BUDGETS,
  CONSOLE_BUDGETS,
  CONTROLLER_BUDGETS,
  RENDER_BUDGETS,
);
