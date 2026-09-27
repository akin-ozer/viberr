import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { updateTaskFile } from "~/server/files/task-writer.server";
import {
  deadDependencies,
  dependenciesSatisfied,
  listHeldTasks,
  resolveDependencies,
  tasksReleasedBy,
} from "./dependencies.server";

/**
 * Ruling 131 (pass 34): every `blockedBy` entry resolves at READ time from the
 * projections, a task key to its own state. Ruling 503 retired the second
 * spelling, a goal link, with the goal chains.
 *
 * Canary: map an archived task to `open` and the dead cases below fail.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function seed(store: TestStore) {
  writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
  writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-2", { stage: "done" }) });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-3", { stage: "impl", archived: true }),
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-4", { stage: "impl", blockedBy: ["VIB-1", "VIB-2"] }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

describe("resolveDependencies (ruling 131)", () => {
  it("resolves task keys: open at a working stage, done at the terminal stage, failed when archived, missing when unknown", () => {
    const store = setupTestStore(ctx);
    seed(store);
    const entries = resolveDependencies(store.db, store.slug, ["VIB-1", "VIB-2", "VIB-3", "VIB-99"]);
    expect(entries.map((e) => [e.ref, e.state, e.taskKey])).toEqual([
      ["VIB-1", "open", "VIB-1"],
      ["VIB-2", "done", "VIB-2"],
      ["VIB-3", "failed", "VIB-3"],
      ["VIB-99", "missing", "VIB-99"],
    ]);
    expect(dependenciesSatisfied(entries)).toBe(false);
    expect(dependenciesSatisfied(entries.slice(1, 2))).toBe(true);
    expect(deadDependencies(entries).map((e) => e.ref)).toEqual(["VIB-3", "VIB-99"]);
    // An unparseable spelling a hand edit left behind reads missing, never throws.
    expect(resolveDependencies(store.db, store.slug, ["nope"])[0]?.state).toBe("missing");
  });

  it("ruling 503: a goal-link spelling handed to the resolver reads missing, never open", () => {
    // The chains are gone, so nothing can answer `goal-1 link 2`. The file
    // schema already drops the spelling with a diagnostic; a caller that still
    // passes it must see a wait that can never clear, not a live one.
    // CANARY: resolve an unparseable ref to `open`.
    const store = setupTestStore(ctx);
    seed(store);
    expect(resolveDependencies(store.db, store.slug, ["goal-1 link 2"])).toEqual([
      { ref: "goal-1 link 2", label: "goal-1 link 2", state: "missing", taskKey: null },
    ]);
  });

  it("a hand-moved task's own state is what its dependents read", async () => {
    const store = setupTestStore(ctx);
    seed(store);
    expect(resolveDependencies(store.db, store.slug, ["VIB-1"])[0]?.state).toBe("open");
    await updateTaskFile(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      (parsed) => {
        parsed.frontmatter.stage = "done";
      },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(resolveDependencies(store.db, store.slug, ["VIB-1"])[0]?.state).toBe("done");
  });

  it("listHeldTasks names every non-archived task with a non-empty list, verbatim from the projection", () => {
    const store = setupTestStore(ctx);
    seed(store);
    expect(listHeldTasks(store.db, store.slug)).toEqual([
      { taskKey: "VIB-4", blockedBy: ["VIB-1", "VIB-2"] },
    ]);
  });
});

/**
 * Ruling 300 (pass 37, F37-135): what answering a decision RELEASES.
 *
 * The controller read three decision cards and worked out by hand, across two
 * turns, that five tasks sat behind them: "the one number that should order a
 * decision queue does not exist, so the ordering depends on whoever happens to
 * have walked the graph recently."
 */
describe("tasksReleasedBy (ruling 300)", () => {
  function chain(store: TestStore) {
    // A → B → C, plus D which also waits on something that can never clear.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { stage: "impl", archived: true }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl", blockedBy: ["VIB-1"] }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: "impl", blockedBy: ["VIB-2"] }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-4", { stage: "impl", blockedBy: ["VIB-1", "VIB-9"] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("counts the whole chain, but says which hop each task is on", () => {
    const store = setupTestStore(ctx);
    chain(store);
    /**
     * Ruling 336: still the whole chain — CANARY: stop after the direct
     * dependents and VIB-3 disappears, which is the number the controller had
     * to compute by hand — but split by WHEN, because the two are not the same
     * event.
     *
     * VIB-2's last wait is VIB-1, so it moves when VIB-1 completes. VIB-3 waits
     * on VIB-2, which must then be built, reviewed, verified and accepted. Live:
     * SHOP-28 merged at 21:40:32; SHOP-29 and SHOP-41 released two seconds
     * later, and SHOP-49 at 22:33:53 — fifty-three minutes on, two and a half
     * seconds after SHOP-29's own merge. One click freed two, not three.
     *
     * CANARY: put them back in one array (or push everything to `direct`).
     */
    // VIB-4 also waits on archived VIB-9, so finishing VIB-1 frees nothing for
    // it. CANARY: drop the dead-wait filter and VIB-4 joins `direct`.
    expect(tasksReleasedBy(store.db, store.slug, "VIB-1")).toEqual({
      direct: ["VIB-2"],
      downstream: ["VIB-3"],
    });
    expect(tasksReleasedBy(store.db, store.slug, "VIB-2")).toEqual({
      direct: ["VIB-3"],
      downstream: [],
    });
  });

  it("a task nothing waits on releases nothing, and says so as an empty list", () => {
    const store = setupTestStore(ctx);
    chain(store);
    const none = { direct: [], downstream: [] };
    expect(tasksReleasedBy(store.db, store.slug, "VIB-3")).toEqual(none);
    expect(tasksReleasedBy(store.db, store.slug, "VIB-404")).toEqual(none);
  });
});
