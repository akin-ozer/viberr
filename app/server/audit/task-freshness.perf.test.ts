import { afterEach, describe, expect, it } from "vitest";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { tallyServerReads } from "../../../test-support/perf-counters";
import { createTestDbContext } from "../../../test-support/test-db";
import { latestTaskReconcileCheckAt } from "./audit-query.server";
import {
  createReconcileBehindByLookup,
  latestReconcileSync,
  latestTaskReconcileAt,
  taskProvenancePath,
} from "~/server/provenance/provenance-query.server";

/**
 * Ruling 457, journey `task-open`: the GitHub freshness facts the task loader
 * reads on every load (and the reconciler on every per-task tick) filter
 * `audit_events` and `provenance` by several equality columns. Both tables
 * grow with time: the per-tick `github.reconcile.task` audit row alone adds
 * ~288 rows per delivered task per day, kept for 90 days. An index that binds
 * only ONE of the filtered columns makes each read walk every task's rows.
 *
 * Counted here: the freshness reads whose query plan leaves a filtered column
 * unbound by its index (EXPLAIN QUERY PLAN on the fresh baseline schema).
 */

const ctx = createTestDbContext();
afterEach(() => ctx.cleanup());

/** The equality columns an index binds, from a SEARCH line's `(a=? AND b=?)`. */
function boundColumns(detail: string): number {
  const m = /\(([^)]*)\)\s*$/.exec(detail);
  return m ? (m[1]!.match(/=\?/g) ?? []).length : 0;
}

describe("task freshness reads (ruling 457)", () => {
  it("bind every filtered column through an index", async () => {
    const db = ctx.makeDb();
    const path = taskProvenancePath("viberr-core", "VIB-142");
    const { tally } = await tallyServerReads("/nonexistent-store-root", () => {
      latestTaskReconcileCheckAt(db, "viberr-core", "VIB-142");
      latestTaskReconcileAt(db, "viberr-core", "VIB-142");
      createReconcileBehindByLookup(db)(path);
      latestReconcileSync(db, path);
    });
    expect(tally.statements).toHaveLength(4);
    const plans = tally.statements.map(({ sql }) => {
      const filtered = (sql.match(/=\s*\?/g) ?? []).length;
      const params = Array.from({ length: filtered }, () => "x");
      // SAFETY: EXPLAIN QUERY PLAN rows always carry a TEXT `detail`.
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
      const search = plan.map((p) => p.detail).find((d) => d.startsWith("SEARCH ")) ?? "";
      return { filtered, search };
    });
    // The "last checked" MAX is answered from the index alone.
    expect(plans[0]?.search).toContain("COVERING INDEX idx_audit_events__task_action");
    const partial = plans.filter((p) => boundColumns(p.search) < p.filtered);
    expectWithinBudget("server-read:task-freshness.partially-indexed-reads", partial.length);
  });
});
