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
 * projections — a task key to its own state, a goal link to its task's state
 * once the chain created it, else to the link's status.
 *
 * Canary: map a `skipped` link to `open` (or an archived task to `open`) and
 * the settled/dead cases below fail.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ACTOR = (store: TestStore) => ({ userId: store.users.arda.id, label: store.users.arda.email });

function seed(store: TestStore) {
  writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
  writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-2", { stage: "done" }) });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-3", { stage: "impl", archived: true }),
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-4", { stage: "impl", blockedBy: ["VIB-1", "goal-1 link 2"] }),
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

  it("resolves goal links through the chain: the link's task once created, else its status; a skipped link counts as done", async () => {
    const store = setupTestStore(ctx);
    seed(store);
    const { createGoal, updateGoal } = await import("~/server/tasks/goal-actions.server");
    const created = await createGoal(
      store.db,
      {
        projectSlug: store.slug,
        title: "Foundation",
        links: [
          { title: "one", goal: "first" },
          { title: "two", goal: "second" },
          { title: "three", goal: "third" },
        ],
      },
      ACTOR(store),
      { dataRoot: store.dataRoot },
    );
    expect(created.goalId).toBe("goal-1");
    // Link 1 has a task (open); link 2 is pending; link 3 will be skipped.
    await updateGoal(
      store.db,
      { projectSlug: store.slug, goalId: "goal-1", action: { op: "skip_link", index: 3 } },
      ACTOR(store),
      { dataRoot: store.dataRoot },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const entries = resolveDependencies(store.db, store.slug, [
      "goal-1 link 1",
      "goal-1 link 2",
      "goal-1 link 3",
      "goal-1 link 9",
      "goal-7 link 1",
    ]);
    expect(entries[0]!.state).toBe("open");
    expect(entries[0]!.taskKey).toBe(created.activeTaskKey);
    expect(entries[0]!.label).toBe(`goal-1 link 1 (${created.activeTaskKey})`);
    expect(entries[1]).toMatchObject({ state: "open", taskKey: null, goalId: "goal-1" });
    expect(entries[2]).toMatchObject({ state: "done", taskKey: null });
    expect(entries[3]).toMatchObject({ state: "missing", goalId: "goal-1" });
    expect(entries[4]).toMatchObject({ state: "missing", goalId: "goal-7" });

    // A hand-moved link task: the task's OWN state wins over the stored link status.
    await updateTaskFile(
      { projectSlug: store.slug, taskKey: created.activeTaskKey!, dataRoot: store.dataRoot },
      (parsed) => {
        parsed.frontmatter.stage = "done";
      },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(resolveDependencies(store.db, store.slug, ["goal-1 link 1"])[0]?.state).toBe("done");
  });

  it("listHeldTasks names every non-archived task with a non-empty list, verbatim from the projection", () => {
    const store = setupTestStore(ctx);
    seed(store);
    expect(listHeldTasks(store.db, store.slug)).toEqual([
      { taskKey: "VIB-4", blockedBy: ["VIB-1", "goal-1 link 2"] },
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
    // A → B → C, plus D which also waits on something that can never clear,
    // plus E which waits on A and on a goal link that has no task yet.
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
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-5", {
        stage: "impl",
        blockedBy: ["VIB-1", "goal-1 link 2"],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("counts the whole chain, not just what waits on it directly", () => {
    const store = setupTestStore(ctx);
    chain(store);
    // CANARY: stop after the direct dependents and VIB-3 disappears, which is
    // exactly the number the controller had to compute by hand.
    expect(tasksReleasedBy(store.db, store.slug, "VIB-1").sort()).toEqual(["VIB-2", "VIB-3"]);
    expect(tasksReleasedBy(store.db, store.slug, "VIB-2").sort()).toEqual(["VIB-3"]);
  });

  it("never counts a task whose OTHER wait can never clear", () => {
    const store = setupTestStore(ctx);
    chain(store);
    // VIB-4 also waits on an ARCHIVED task. Finishing VIB-1 frees nothing for
    // it, and counting it would inflate the one number a person orders their
    // queue by. CANARY: drop the dead-wait filter.
    expect(tasksReleasedBy(store.db, store.slug, "VIB-1")).not.toContain("VIB-4");
  });

  it("never counts a task still waiting on a goal link that has no task yet", async () => {
    const store = setupTestStore(ctx);
    chain(store);
    // A link that is genuinely OPEN and has no task: `state: "open"`,
    // `taskKey: null`. It is a real wait, and no task key completing satisfies
    // it, so it must survive the walk rather than being dropped as unmatched.
    const { createGoal } = await import("~/server/tasks/goal-actions.server");
    const created = await createGoal(
      store.db,
      {
        projectSlug: store.slug,
        title: "Foundation",
        links: [
          { title: "one", goal: "first" },
          { title: "two", goal: "second" },
        ],
      },
      ACTOR(store),
      { dataRoot: store.dataRoot },
    );
    expect(created.goalId).toBe("goal-1");
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(
      resolveDependencies(store.db, store.slug, ["goal-1 link 2"])[0],
    ).toMatchObject({ state: "open", taskKey: null });

    // CANARY: `.map((e) => e.taskKey).filter(Boolean)` drops it, VIB-5's set
    // empties on VIB-1 alone, and a task that is still waiting is counted as
    // released.
    expect(tasksReleasedBy(store.db, store.slug, "VIB-1")).not.toContain("VIB-5");
  });

  it("a task nothing waits on releases nothing, and says so as an empty list", () => {
    const store = setupTestStore(ctx);
    chain(store);
    expect(tasksReleasedBy(store.db, store.slug, "VIB-3")).toEqual([]);
    expect(tasksReleasedBy(store.db, store.slug, "VIB-404")).toEqual([]);
  });
});
