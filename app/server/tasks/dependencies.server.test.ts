import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { createGoalFile } from "~/server/files/goal-writer.server";
import { getTaskSummary } from "~/server/projections/task-query.server";
import type { DatabaseSync } from "node:sqlite";
import type { RunOperatorInput } from "~/server/runtimes/operator-run.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { writeProject } from "../../../test-support/test-store";
import { setPref } from "~/server/prefs/user-prefs.server";
import { NOTIFS_PREF_KEY } from "~/features/profile/profile-query.server";
import { setTaskArchived, transitionStage } from "./task-actions.server";
import { goalRunnerTick } from "./goal-actions.server";
import {
  announceRelease,
  clearDependencies,
  noteDeadDependency,
  releaseDependents,
  releaseDueDependents,
  releaseTask,
  setTaskDependencies,
  validateDependencyRefs,
} from "./dependencies.server";

/**
 * Ruling 131(b)/(e) (pass 34, Q34-11): the ONE writer for `blockedBy`, its
 * validation against the store, and the two halves of a release.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function actor(store: TestStore, who: "arda" | "murat" | "selin" | "deniz") {
  const u = store.users[who];
  return { userId: u.id, label: u.email };
}

async function seed(store: TestStore): Promise<void> {
  const seeds: [string, Parameters<typeof baseTaskFrontmatter>[1]][] = [
    ["VIB-1", { stage: "impl", waiting: "human" }],
    ["VIB-2", { stage: "done", waiting: "none" }],
    ["VIB-3", { stage: "impl", archived: true }],
    ["VIB-4", { stage: "impl", waiting: "human", blockedBy: ["VIB-5"] }],
    ["VIB-5", { stage: "impl", waiting: "human" }],
  ];
  for (const [key, over] of seeds) {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, over) });
  }
  // goal-1: link 1 carries VIB-5, link 2 has no task yet; goal-2 link 1
  // DECLARES a wait on goal-1 link 2 (the sibling-chain shape ruling 131(c)
  // exists for).
  const goal = (id: string, links: { index: number; taskKey: string | null; blockedBy: string[] }[]) =>
    createGoalFile(
      { projectSlug: store.slug, goalId: id, dataRoot: store.dataRoot },
      {
        frontmatter: {
          id,
          title: id,
          status: "active",
          createdBy: store.users.arda.id,
          createdByLabel: store.users.arda.email,
          onFailure: "pause",
          links: links.map((l) => ({
            index: l.index,
            title: `link ${l.index}`,
            goal: "g",
            taskKey: l.taskKey,
            status: l.taskKey ? "active" : "pending",
            note: null,
            blockedBy: l.blockedBy,
          })),
          createdAt: null,
          updatedAt: null,
        },
        description: "",
      },
    );
  await goal("goal-1", [
    { index: 1, taskKey: "VIB-5", blockedBy: [] },
    { index: 2, taskKey: null, blockedBy: [] },
  ]);
  await goal("goal-2", [{ index: 1, taskKey: null, blockedBy: ["goal-1 link 2"] }]);
  // An operator is deployed so a release has someone to re-invoke
  // (`autoInvokeOperator` returns early without one).
  const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...pf.parsed.frontmatter,
    agents: [
      ...pf.parsed.frontmatter.agents,
      {
        profileId: "operator",
        capabilities: [
          { capabilityId: "generate-packets", mode: "direct" },
          { capabilityId: "append-typed-events", mode: "direct" },
        ],
        extras: [],
        definition: { kind: "operator", name: "Operator", role: "Task coordinator", backends: ["claude"], model: "sonnet", autonomy: "supervised" },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

const file = (store: TestStore, key: string) =>
  readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed;

describe("validateDependencyRefs", () => {
  it("refuses unparseable, self, unknown, archived, out-of-range and cyclic references, each by name", async () => {
    // Canary: remove the cycle walk (`cyclePath`) and the last two refusals
    // pass validation.
    const store = setupTestStore(ctx);
    await seed(store);
    const validate = (self: Parameters<typeof validateDependencyRefs>[1]["self"], entries: string[]) =>
      validateDependencyRefs(store.db, { projectSlug: store.slug, self, entries });
    const self = { kind: "task" as const, task: "VIB-1" };
    expect(() => validate(self, ["nonsense words"])).toThrow(/"nonsense words" is not a task key or a goal link/);
    expect(() => validate(self, ["VIB-1"])).toThrow(/VIB-1: a task cannot wait on itself/);
    expect(() => validate(self, ["VIB-999"])).toThrow(/VIB-999 is not a task in this project/);
    expect(() => validate(self, ["VIB-3"])).toThrow(/VIB-3 is archived/);
    expect(() => validate(self, ["goal-9 link 1"])).toThrow(/goal-9 is not a goal in this project/);
    expect(() => validate(self, ["goal-1 link 7"])).toThrow(/goal-1 has no link 7 \(it has 2\)/);
    // VIB-4 waits on VIB-5; VIB-5 waiting on VIB-4 closes the cycle.
    expect(() => validate({ kind: "task", task: "VIB-5" }, ["VIB-4"])).toThrow(
      /Waiting on VIB-4 would close a cycle: VIB-5 waits on VIB-4 waits on VIB-5/,
    );
    // goal-1 link 1 IS VIB-5, so the same cycle through the link spelling.
    expect(() => validate({ kind: "task", task: "VIB-4" }, ["goal-1 link 1", "VIB-4"])).toThrow(/cannot wait on itself/);
    // A DECLARED edge: goal-2 link 1 waits on goal-1 link 2 (no task yet);
    // goal-1 link 2 waiting on goal-2 link 1 would close a cycle.
    expect(() => validate({ kind: "goal", goal: "goal-1", link: 2 }, ["goal-2 link 1"])).toThrow(
      /would close a cycle: goal-1 link 2 waits on goal-2 link 1 waits on goal-1 link 2/,
    );
    // Canonical spellings, de-duplicated, blanks dropped.
    expect(validate(self, [" VIB-2 ", "goal-1 link 2", "", "vib-2", "Goal-1 Link 2"])).toEqual(["VIB-2", "goal-1 link 2"]);
  });
});

describe("setTaskDependencies", () => {
  it("writes the list, the note, the audit row and waiting: none; an unchanged list short-circuits", async () => {
    // Canary: delete the `waiting = "none"` assignment (VIB-1 stays `human`).
    const store = setupTestStore(ctx);
    await seed(store);
    const result = await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["goal-1 link 2", "VIB-2"] },
      actor(store, "arda"),
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({ changed: true, blockedBy: ["goal-1 link 2", "VIB-2"], added: ["goal-1 link 2", "VIB-2"], removed: [] });
    const parsed = file(store, "VIB-1");
    expect(parsed.frontmatter.blockedBy).toEqual(["goal-1 link 2", "VIB-2"]);
    expect(parsed.frontmatter.waiting).toBe("none");
    expect(parsed.timeline[0]).toMatchObject({ type: "note", title: "Dependencies updated" });
    expect(parsed.timeline[0]!.text).toContain("Waits on goal-1 link 2, VIB-2 (added goal-1 link 2, VIB-2)");
    expect(result.task.readiness).toBe("blocked");
    expect(result.task.blockedBy.map((e) => [e.ref, e.state])).toEqual([
      ["goal-1 link 2", "open"],
      ["VIB-2", "done"],
    ]);
    const rows = listAuditEvents(store.db).filter((e) => e.action === "task.dependencies.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ blockedBy: ["goal-1 link 2", "VIB-2"], added: ["goal-1 link 2", "VIB-2"], removed: [] });

    const again = await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["goal-1 link 2", "vib-2"] },
      actor(store, "arda"),
      { dataRoot: store.dataRoot },
    );
    expect(again.changed).toBe(false);
    expect(file(store, "VIB-1").timeline).toHaveLength(parsed.timeline.length);
    expect(listAuditEvents(store.db).filter((e) => e.action === "task.dependencies.updated")).toHaveLength(1);
  });

  it("keeps waiting when a packet or a running agent still owes something; refuses an archived task and a viewer", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-6", { stage: "impl", waiting: "agent" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-6", blockedBy: ["VIB-5"] }, actor(store, "arda"), { dataRoot: store.dataRoot });
    expect(file(store, "VIB-6").frontmatter.waiting).toBe("agent");

    await expect(
      setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-3", blockedBy: ["VIB-5"] }, actor(store, "arda"), { dataRoot: store.dataRoot }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("VIB-3 is archived; restore it before editing what it waits on") });
    // deniz is the seeded viewer.
    await expect(
      setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-5"] }, actor(store, "deniz"), { dataRoot: store.dataRoot }),
    ).rejects.toMatchObject({ status: 403 });
    // The operator is not gated (in-process authority).
    const op = await setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-5"] }, { userId: "operator", label: "operator" }, { dataRoot: store.dataRoot, operatorAuthorized: true });
    expect(op.changed).toBe(true);
    expect(file(store, "VIB-1").timeline[0]!.actor).toEqual({ kind: "operator" });
  });

  it("a human emptying the list produces the RELEASE, not a bare clear: one note, the audit row, the notification and the re-invoke", async () => {
    // Canary: call `clearDependencies` without `announceRelease` in the
    // releasing arm (no release note, no `task.dependencies.released` row).
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-7", {
        stage: "impl",
        waiting: "none",
        readiness: "blocked",
        heldAtStage: "impl",
        blockedBy: ["VIB-5"],
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const runOperator = runOperatorStub();
    const result = await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-7", blockedBy: [] },
      actor(store, "murat"),
      { dataRoot: store.dataRoot, deps: { runOperator } },
    );
    expect(result).toMatchObject({ changed: true, blockedBy: [], removed: ["VIB-5"] });
    const parsed = file(store, "VIB-7");
    expect(parsed.frontmatter.blockedBy).toEqual([]);
    expect(parsed.frontmatter.heldAtStage).toBeNull();
    expect(parsed.frontmatter.readiness).toBe("ready");
    const notes = parsed.timeline.filter((e) => e.type === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("Dependencies released");
    expect(notes[0]!.text).toContain(`${store.users.murat.email} cleared the wait on VIB-5`);
    const actions = listAuditEvents(store.db).map((e) => e.action);
    expect(actions).toContain("task.dependencies.updated");
    expect(actions).toContain("task.dependencies.released");
    // SAFETY: `kind`, `user_id`, `text` are NOT NULL on `notifications`.
    const notifs = store.db
      .prepare(`SELECT user_id, kind, text FROM notifications WHERE task_key = 'VIB-7'`)
      .all() as { user_id: string; kind: string; text: string }[];
    expect(notifs.some((n) => n.kind === "dependency" && n.user_id === store.users.arda.id)).toBe(true);
    expect(getTaskSummary(store.db, store.slug, "VIB-7")!.readiness).toBe("ready");
  });
});

describe("the two release halves", () => {
  it("clearDependencies clears the list and the hold and lifts a stored blocked; announceRelease writes the engine's note", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-8", { stage: "impl", readiness: "blocked", heldAtStage: "impl", blockedBy: ["VIB-2", "VIB-5"] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const parsed = file(store, "VIB-8");
    expect(clearDependencies(parsed)).toEqual(["VIB-2", "VIB-5"]);
    expect(parsed.frontmatter).toMatchObject({ blockedBy: [], heldAtStage: null, readiness: "ready" });
    await announceRelease(store.db, { dataRoot: store.dataRoot, deps: { runOperator: runOperatorStub() } }, store.slug, "VIB-8", { entries: ["VIB-2", "VIB-5"] });
    const note = file(store, "VIB-8").timeline[0]!;
    expect(note.title).toBe("Dependencies released");
    expect(note.text).toContain("everything this task waited on is done (VIB-2, VIB-5)");
    expect(note.text).toContain("the base branch has changed since the hold");
    expect(note.actor).toEqual({ kind: "system", systemId: "dependency-release" });
    expect(listAuditEvents(store.db).find((e) => e.action === "task.dependencies.released")!.details).toMatchObject({ entries: ["VIB-2", "VIB-5"], clearedBy: null });
  });
});

async function eventually(assertion: () => void, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

const runOperatorStub = () =>
  vi.fn((_db: DatabaseSync, _input: RunOperatorInput) =>
    Promise.resolve({ runId: "run_x", queued: false, backend: "claude" as const, autonomy: "supervised" as const }),
  );

/** Ruling 131(e): the release engine. */
describe("the release engine", () => {
  it("completing the LAST dependency releases the dependent through the transition hook: list cleared, note, readiness lifted, hold cleared, watchers notified, operator re-invoked with the payload; a partial completion releases nothing", async () => {
    // Canaries: delete the `autoInvokeOperator` call in `announceRelease`
    // (no re-invoke); treat `failed` as satisfied in `dependenciesSatisfied`
    // (the archived case below releases).
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-10", {
        stage: "impl",
        waiting: "none",
        readiness: "blocked",
        heldAtStage: "impl",
        blockedBy: ["VIB-2", "VIB-5", "VIB-1"],
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const runOperator = runOperatorStub();
    const ctxWith = { dataRoot: store.dataRoot, deps: { runOperator } };
    // VIB-2 is done, VIB-5 and VIB-1 are not: a partial completion. A move
    // of VIB-5 towards review fires the hook, which releases nothing.
    expect(await releaseDependents(store.db, ctxWith, store.slug)).toEqual([]);
    await transitionStage(store.db, { projectSlug: store.slug, taskKey: "VIB-5", toStageId: "review", manual: true }, actor(store, "arda"), ctxWith);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(file(store, "VIB-10").frontmatter.blockedBy).toEqual(["VIB-2", "VIB-5", "VIB-1"]);
    // Both land (accepted by hand here; the acceptance path fires the same
    // hook), then ANY task write with the hook releases VIB-10: the sweep
    // reads the project's live state, not the moved task's.
    for (const key of ["VIB-5", "VIB-1"]) {
      writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, { stage: "done", waiting: "none" }) });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await transitionStage(store.db, { projectSlug: store.slug, taskKey: "VIB-4", toStageId: "review", manual: true }, actor(store, "arda"), ctxWith);
    // The re-invoke is the LAST step of the release; waiting on it means the
    // note, the audit row and the notification have all landed.
    await eventually(() =>
      expect(runOperator.mock.calls.some((c) => c[1].trigger === "dependencies-released")).toBe(true),
    );
    const parsed = file(store, "VIB-10");
    expect(parsed.frontmatter.blockedBy).toEqual([]);
    expect(parsed.frontmatter.heldAtStage).toBeNull();
    expect(parsed.frontmatter.readiness).toBe("ready");
    const note = parsed.timeline.find((e) => e.title === "Dependencies released")!;
    expect(note.text).toContain("everything this task waited on is done (VIB-2, VIB-5, VIB-1)");
    expect(getTaskSummary(store.db, store.slug, "VIB-10")!.readiness).toBe("ready");
    // SAFETY: `kind`, `user_id` are NOT NULL on `notifications`.
    const notifs = store.db
      .prepare(`SELECT user_id, kind FROM notifications WHERE task_key = 'VIB-10' AND kind = 'dependency'`)
      .all() as { user_id: string; kind: string }[];
    expect(notifs.map((n) => n.user_id)).toContain(store.users.arda.id);
    const release = runOperator.mock.calls.find((c) => c[1].trigger === "dependencies-released");
    expect(release).toBeDefined();
    expect(release![1].dependencyRelease).toEqual({ entries: ["VIB-2", "VIB-5", "VIB-1"], clearedBy: null });
    // VIB-4 (seeded waiting on VIB-5) was released by the same sweep; VIB-10's
    // own release is exactly one row.
    expect(listAuditEvents(store.db).filter((e) => e.action === "task.dependencies.released" && e.taskKey === "VIB-10")).toHaveLength(1);
  });

  it("a skipped goal link counts as done; an archived dependency is noted ONCE, notifies once, sets waiting: human and never releases", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    // goal-3: link 1 skipped, no task.
    await createGoalFile(
      { projectSlug: store.slug, goalId: "goal-3", dataRoot: store.dataRoot },
      {
        frontmatter: {
          id: "goal-3", title: "goal-3", status: "active", createdBy: store.users.arda.id, createdByLabel: "arda",
          onFailure: "continue",
          links: [{ index: 1, title: "l1", goal: "g", taskKey: null, status: "skipped", note: null, blockedBy: [] }],
          createdAt: null, updatedAt: null,
        },
        description: "",
      },
    );
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-11", { stage: "impl", waiting: "none", blockedBy: ["goal-3 link 1"] }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-12", { stage: "impl", waiting: "none", blockedBy: ["VIB-5"], ownerUserId: store.users.arda.id }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runOperator = runOperatorStub();
    const ctxWith = { dataRoot: store.dataRoot, deps: { runOperator } };
    expect(await releaseDependents(store.db, ctxWith, store.slug)).toEqual(["VIB-11"]);

    await setTaskArchived(store.db, { projectSlug: store.slug, taskKey: "VIB-5", archived: true }, actor(store, "arda"), ctxWith);
    const held = file(store, "VIB-12");
    expect(held.frontmatter.blockedBy).toEqual(["VIB-5"]);
    expect(held.frontmatter.waiting).toBe("human");
    const dead = held.timeline.filter((e) => e.title === "Waiting on work that cannot complete");
    expect(dead).toHaveLength(1);
    expect(dead[0]!.text).toContain("VIB-5 can never complete");
    expect(getTaskSummary(store.db, store.slug, "VIB-12")!.blockedBy[0]!.state).toBe("failed");
    // Idempotent: a second pass writes nothing more.
    expect(await noteDeadDependency(store.db, ctxWith, store.slug, "VIB-5")).toEqual([]);
    expect(file(store, "VIB-12").timeline.filter((e) => e.title === "Waiting on work that cannot complete")).toHaveLength(1);
    // SAFETY: `user_id`, `kind` are NOT NULL on `notifications`.
    const rows = store.db
      .prepare(`SELECT user_id FROM notifications WHERE task_key = 'VIB-12' AND kind = 'dependency'`)
      .all() as { user_id: string }[];
    expect(rows.filter((r) => r.user_id === store.users.arda.id)).toHaveLength(1);
    // Never released: the sweep leaves it alone.
    expect(await releaseDependents(store.db, ctxWith, store.slug)).toEqual([]);
    expect(runOperator.mock.calls.some((c) => c[1].taskKey === "VIB-12")).toBe(false);
  });

  it("the release is convergent, and the runner's tick releases what the hooks never saw", async () => {
    // Canaries: remove the `blockedBy = []` write in `clearDependencies` (a
    // second `releaseTask` releases again); drop `releaseDueDependents` from
    // `goalRunnerTick` (the hand-edited task stays held).
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-13", { stage: "impl", waiting: "none", blockedBy: ["VIB-2"] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const ctxWith = { dataRoot: store.dataRoot, deps: { runOperator: runOperatorStub() } };
    expect(await releaseTask(store.db, ctxWith, store.slug, "VIB-13")).toBe(true);
    expect(await releaseTask(store.db, ctxWith, store.slug, "VIB-13")).toBe(false);
    expect(file(store, "VIB-13").timeline.filter((e) => e.title === "Dependencies released")).toHaveLength(1);

    // A hand edit the hooks never saw: VIB-14 waits on the already-done VIB-2.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-14", { stage: "impl", waiting: "none", blockedBy: ["VIB-2"] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(await releaseDueDependents(store.db, ctxWith)).toBe(1);
    expect(file(store, "VIB-14").frontmatter.blockedBy).toEqual([]);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-15", { stage: "impl", waiting: "none", blockedBy: ["VIB-2"] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect((await goalRunnerTick(store.db, ctxWith)).released).toBe(1);
    expect(file(store, "VIB-15").frontmatter.blockedBy).toEqual([]);
  });

  it("with the person's `dependencies` toggle off, the note, the audit row and the re-invoke still land while no row is written for them", async () => {
    // Canary: map `dependency` to `controller` in `KIND_TO_CATEGORY` (arda's
    // controller toggle is on, so a row lands).
    const store = setupTestStore(ctx);
    await seed(store);
    setPref(store.db, store.users.arda.id, NOTIFS_PREF_KEY, { dependencies: { app: false } });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-16", { stage: "impl", waiting: "none", blockedBy: ["VIB-2"], ownerUserId: store.users.arda.id }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const runOperator = runOperatorStub();
    expect(await releaseTask(store.db, { dataRoot: store.dataRoot, deps: { runOperator } }, store.slug, "VIB-16")).toBe(true);
    expect(file(store, "VIB-16").timeline[0]!.title).toBe("Dependencies released");
    expect(listAuditEvents(store.db).some((e) => e.action === "task.dependencies.released")).toBe(true);
    expect(runOperator).toHaveBeenCalledTimes(1);
    // SAFETY: `user_id` is NOT NULL on `notifications`.
    const rows = store.db
      .prepare(`SELECT user_id FROM notifications WHERE task_key = 'VIB-16' AND kind = 'dependency'`)
      .all() as { user_id: string }[];
    expect(rows.some((r) => r.user_id === store.users.arda.id)).toBe(false);
    // murat (maintainer) keeps his default ON and still hears about it.
    expect(rows.some((r) => r.user_id === store.users.murat.id)).toBe(true);
  });
});

/**
 * Pass 34 review: two ways the release engine spoke for a task it should not
 * have — a DONE task announced as "released", and a list judged out of lock
 * then cleared whatever the file held by then.
 */
describe("the release engine speaks only for a task that is actually waiting", () => {
  it("a task already in the terminal stage is cleared QUIETLY: no note, no re-invoke", async () => {
    // Canary: drop the terminal check — the closed task gets a "can move
    // again" note and pays an unwatched operator turn.
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-11", {
        stage: "done",
        waiting: "none",
        blockedBy: ["VIB-2"],
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const runOperator = runOperatorStub();
    const released = await releaseDependents(
      store.db,
      { dataRoot: store.dataRoot, deps: { runOperator } },
      store.slug,
    );
    expect(released).toEqual([]);
    const parsed = file(store, "VIB-11");
    expect(parsed.frontmatter.blockedBy).toEqual([]); // cleared, so no stale chip
    expect(parsed.timeline.some((e) => e.title === "Dependencies released")).toBe(false);
    expect(runOperator.mock.calls).toHaveLength(0);
  });

  it("a wait added between the satisfaction check and the write is NOT dropped", async () => {
    // Canary: clear whatever the file holds without re-reading the list —
    // the newly added wait vanishes and a release is announced over it.
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-12", {
        stage: "impl",
        waiting: "none",
        readiness: "blocked",
        blockedBy: ["VIB-2"],
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // The race, made deterministic: a concurrent writer adds an unsatisfied
    // wait AFTER `releaseTask` judged the list and WHILE it waits for the file
    // lock. The spy fires once, on the release's own write.
    const writer = await import("~/server/files/task-writer.server");
    const ref = { projectSlug: store.slug, taskKey: "VIB-12", dataRoot: store.dataRoot };
    const real = writer.updateTaskFile;
    const spy = vi
      .spyOn(writer, "updateTaskFile")
      .mockImplementationOnce(async (target, mutate) => {
        // Land the concurrent write first, then let the release's mutator run
        // against the file it produced.
        await real(ref, (parsed) => {
          parsed.frontmatter.blockedBy = ["VIB-2", "VIB-1"];
        });
        return real(target, mutate);
      });
    const runOperator = runOperatorStub();
    const released = await releaseDependents(
      store.db,
      { dataRoot: store.dataRoot, deps: { runOperator } },
      store.slug,
    );
    spy.mockRestore();
    expect(released).toEqual([]);
    expect(file(store, "VIB-12").frontmatter.blockedBy).toEqual(["VIB-2", "VIB-1"]);
    expect(runOperator.mock.calls).toHaveLength(0);
  });
});

/**
 * Pass 34 review: a wait that can NEVER complete used to be noticed only when
 * a dependency TASK was archived — the one door that called the notice. A
 * cancelled goal, a removed link or a lost task left the dependent held and
 * silent forever.
 */
describe("the sweep notices a dead wait whatever killed it", () => {
  it("a reference to a link that no longer exists is noted by the ordinary sweep", async () => {
    // Canary: call `noteDeadDependency` only from the archive hook again —
    // nothing ever tells the owner this task can never move.
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-13", {
        stage: "impl",
        waiting: "none",
        readiness: "blocked",
        blockedBy: ["goal-1 link 9"],
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runOperator = runOperatorStub();
    const ctxWith = { dataRoot: store.dataRoot, deps: { runOperator } };

    expect(await releaseDependents(store.db, ctxWith, store.slug)).not.toContain("VIB-13");
    const parsed = file(store, "VIB-13");
    const dead = parsed.timeline.filter((e) => e.title === "Waiting on work that cannot complete");
    expect(dead).toHaveLength(1);
    expect(dead[0]!.text).toContain("can never complete");
    expect(parsed.frontmatter.waiting).toBe("human");
    expect(parsed.frontmatter.blockedBy).toEqual(["goal-1 link 9"]);
    // Idempotent: a second sweep writes nothing more.
    await releaseDependents(store.db, ctxWith, store.slug);
    expect(
      file(store, "VIB-13").timeline.filter((e) => e.title === "Waiting on work that cannot complete"),
    ).toHaveLength(1);
  });
});


describe("the archive hook and the convergent sweep state the same fact once", () => {
  it("two archived dependencies produce two notes, not a third from the sweep", async () => {
    // `dead` was FILTERED by the archived key, so the per-key hook spelled
    // "VIB-5 can never complete" while the convergent sweep spelled
    // "VIB-5, VIB-9 can never complete". The idempotence guard is an exact
    // text match by design, so it never matched ACROSS the two doors and the
    // sweep re-stated facts the hooks had already recorded — a duplicate
    // timeline note and a duplicate notification for the owner.
    // Canary: restore the `.filter((e) => archivedKey === null || …)` on
    // `dead` and the sweep adds a third note here.
    const store = setupTestStore(ctx);
    await seed(store);
    for (const key of ["VIB-5", "VIB-9"]) {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, { stage: "impl", waiting: "none" }),
      });
    }
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-14", {
        stage: "impl",
        waiting: "none",
        blockedBy: ["VIB-5", "VIB-9"],
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runOperator = runOperatorStub();
    const ctxWith = { dataRoot: store.dataRoot, deps: { runOperator } };

    const notes = () =>
      file(store, "VIB-14").timeline.filter(
        (e) => e.title === "Waiting on work that cannot complete",
      );

    // Each archive is a real, new fact, so each earns its own note.
    await setTaskArchived(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-5", archived: true },
      actor(store, "arda"),
      ctxWith,
    );
    expect(notes()).toHaveLength(1);
    await setTaskArchived(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-9", archived: true },
      actor(store, "arda"),
      ctxWith,
    );
    expect(notes()).toHaveLength(2);
    // The second note states the WHOLE truth, which is what makes the sweep
    // agree with it instead of restating it in different words.
    expect(notes()[0]!.text).toContain("VIB-5");
    expect(notes()[0]!.text).toContain("VIB-9");

    // The sweep now recognises its own sentence and adds nothing.
    await releaseDependents(store.db, ctxWith, store.slug);
    await noteDeadDependency(store.db, ctxWith, store.slug, null);
    expect(notes(), "the sweep must not restate what the hooks said").toHaveLength(2);
  });
});
