import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { updateTaskFile } from "~/server/files/task-writer.server";
import { setTaskDependencies } from "~/server/tasks/dependencies.server";
import {
  deadDependencies,
  dependenciesSatisfied,
  listDependencyCandidates,
  listHeldTasks,
  resolveDependencies,
  tasksReleasedBy,
} from "./dependencies.server";
import { candidateRefusal } from "~/shared/dependency-candidates";

/**
 * Ruling 55 (pass 34): every `blockedBy` entry names a task and resolves at
 * READ time from the projections to that task's own state.
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

describe("resolveDependencies (ruling 55)", () => {
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

  it("ruling 55: a goal-link spelling handed to the resolver reads missing, never open", () => {
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
 * Ruling 263 (pass 37, F37-135): what answering a decision RELEASES.
 *
 * The controller read three decision cards and worked out by hand, across two
 * turns, that five tasks sat behind them: "the one number that should order a
 * decision queue does not exist, so the ordering depends on whoever happens to
 * have walked the graph recently."
 */
describe("tasksReleasedBy (ruling 263)", () => {
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
     * Ruling 263: still the whole chain — CANARY: stop after the direct
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

/**
 * Ruling 59: the Details panel's Blocked by picker lists the project's other
 * tasks and bars each one the writer would refuse as a new entry, so a person
 * reads the refusal on the row before Save instead of in a toast after it.
 * The writer is the oracle: a bar that disagrees with `setTaskDependencies`
 * offers a task Save then refuses, or hides one it would take, and the
 * sentence the picker says for it is the one Save throws.
 */
describe("listDependencyCandidates (ruling 59)", () => {
  it("lists every other task newest first, barred exactly where the writer refuses it, in the writer's words", async () => {
    // CANARY: walk only the direct waiters and VIB-5, two hops behind VIB-1,
    // reads free while the writer refuses it; skip archived tasks' lists and
    // VIB-7, waiting through archived VIB-6, does the same; sort the keys as
    // text and VIB-10 sinks under VIB-7; keep the first hop only in a
    // cycle's chain and the picker names a cycle Save does not.
    const store = setupTestStore(ctx);
    // VIB-1 at a working stage, VIB-2 done, VIB-3 archived, VIB-4 waiting on VIB-1.
    seed(store);
    const more: [string, Parameters<typeof baseTaskFrontmatter>[1]][] = [
      ["VIB-5", { stage: "impl", blockedBy: ["VIB-4"] }],
      ["VIB-6", { stage: "impl", archived: true, blockedBy: ["VIB-1"] }],
      ["VIB-7", { stage: "impl", blockedBy: ["VIB-6"] }],
      ["VIB-10", { stage: "ready" }],
    ];
    for (const [key, patch] of more) {
      writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, patch) });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const candidates = listDependencyCandidates(store.db, store.slug, "VIB-1")!;
    expect(candidates.map((c) => [c.key, c.bar])).toEqual([
      ["VIB-10", null],
      ["VIB-7", "cycle"],
      ["VIB-6", "archived"],
      ["VIB-5", "cycle"],
      ["VIB-4", "cycle"],
      ["VIB-3", "archived"],
      ["VIB-2", "done"],
    ]);
    expect(candidates[0]).toEqual({ key: "VIB-10", title: "Task VIB-10", stage: "Ready", bar: null });

    const waitOn = (key: string) =>
      setTaskDependencies(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: [key] },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      );
    for (const candidate of candidates) {
      if (candidate.bar) {
        await expect(waitOn(candidate.key), candidate.key).rejects.toThrow(candidateRefusal(candidate));
      }
    }
    await expect(waitOn("VIB-10")).resolves.toMatchObject({ changed: true, blockedBy: ["VIB-10"] });
  });
});
