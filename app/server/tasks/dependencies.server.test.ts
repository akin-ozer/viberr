import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { createGoalFile, readGoalFile } from "~/server/files/goal-writer.server";
import { getTaskSummary } from "~/server/projections/task-query.server";
import type { DatabaseSync } from "node:sqlite";
import type { RunOperatorInput } from "~/server/runtimes/operator-run.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { writeProject } from "../../../test-support/test-store";
import { setPref } from "~/server/prefs/user-prefs.server";
import { NOTIFS_PREF_KEY } from "~/features/profile/profile-query.server";
import { setTaskArchived, transitionStage } from "./task-actions.server";
import { goalRunnerTick } from "./goal-actions.server";
import type { StartAgentRunInput, StartAgentRunResult } from "./specialist-run.server";
import {
  announceRelease,
  clearDependencies,
  drainQueuedQuestions,
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
            redeclared: false,
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
      { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["goal-1 link 2", "VIB-5"] },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({ changed: true, blockedBy: ["goal-1 link 2", "VIB-5"], added: ["goal-1 link 2", "VIB-5"], removed: [] });
    const parsed = file(store, "VIB-1");
    expect(parsed.frontmatter.blockedBy).toEqual(["goal-1 link 2", "VIB-5"]);
    expect(parsed.frontmatter.waiting).toBe("none");
    expect(parsed.timeline[0]).toMatchObject({ type: "note", title: "Dependencies updated" });
    expect(parsed.timeline[0]!.text).toContain("Waits on goal-1 link 2, VIB-5 (added goal-1 link 2, VIB-5)");
    expect(result.task.readiness).toBe("blocked");
    expect(result.task.blockedBy.map((e) => [e.ref, e.state])).toEqual([
      ["goal-1 link 2", "open"],
      ["VIB-5", "open"],
    ]);
    const rows = listAuditEvents(store.db).filter((e) => e.action === "task.dependencies.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ blockedBy: ["goal-1 link 2", "VIB-5"], added: ["goal-1 link 2", "VIB-5"], removed: [] });

    const again = await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["goal-1 link 2", "vib-5"] },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(again.changed).toBe(false);
    expect(file(store, "VIB-1").timeline).toHaveLength(parsed.timeline.length);
    expect(listAuditEvents(store.db).filter((e) => e.action === "task.dependencies.updated")).toHaveLength(1);
  });

  it("F39-63: refuses to ADD a wait on a task that is already done, and keeps one that finished while on the list", async () => {
    // Live on ax-clone AX-29 the operator re-added a wait on the merged AX-32:
    // "Held until every entry is done", released 37 seconds later with "the
    // base branch has changed since the hold". CANARY: drop the refusal and
    // the first call writes the hold.
    const store = setupTestStore(ctx);
    await seed(store);
    await expect(
      setTaskDependencies(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-2"] },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow("VIB-2 is already done, so waiting on it holds nothing. Leave it off the list.");
    expect(file(store, "VIB-1").frontmatter.blockedBy).toEqual([]);
    // VIB-4 waits on VIB-5; VIB-5 finishes; adding another entry keeps the
    // finished one, which is the engine's to release.
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-5", { stage: "done", waiting: "none" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const kept = await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-4", blockedBy: ["VIB-5", "goal-1 link 2"] },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(kept.blockedBy).toEqual(["VIB-5", "goal-1 link 2"]);
  });

  it("keeps waiting when a packet or a running agent still owes something; refuses an archived task and a viewer", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-6", { stage: "impl", waiting: "agent" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-6", blockedBy: ["VIB-5"] }, actorOf(store.users.arda), { dataRoot: store.dataRoot });
    expect(file(store, "VIB-6").frontmatter.waiting).toBe("agent");

    await expect(
      setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-3", blockedBy: ["VIB-5"] }, actorOf(store.users.arda), { dataRoot: store.dataRoot }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("VIB-3 is archived; restore it before editing what it waits on") });
    // deniz is the seeded viewer.
    await expect(
      setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-5"] }, actorOf(store.users.deniz), { dataRoot: store.dataRoot }),
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
      actorOf(store.users.murat),
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
    // U39-18: the note names the person who cleared it, not their address.
    expect(notes[0]!.text).toContain(`${store.users.murat.name} cleared the wait on VIB-5`);
    expect(notes[0]!.text).not.toContain(store.users.murat.email);
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

/**
 * Ruling 331 (pass 37, F37-167) shipped without a canary, which is how this
 * note said two false things for a day: it reduced an `error` that was in scope
 * and being logged on the line above to "(an internal error)", and then claimed
 * "Coordination is paused for this task" — live on SHOP-38 the operator was
 * re-invoked automatically eleven seconds later, leaving that durable line as
 * the only thing still saying the task had stopped.
 *
 * `autoInvokeOperator`'s failure arm is reachable from every trigger; a release
 * is the cheapest one to drive.
 */
describe("ruling 331: a failed auto-invocation names its cause and claims nothing", () => {
  it("writes the thrown reason, the trigger, and no claim that coordination stopped", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-10", {
        stage: "impl",
        waiting: "none",
        readiness: "blocked",
        heldAtStage: "impl",
        blockedBy: ["VIB-2"],
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const runOperator = vi.fn((_db: DatabaseSync, _input: RunOperatorInput) =>
      Promise.reject(new Error("no runtime is deployed for claude")),
    );
    // VIB-2 is already done, so the release fires and its re-invoke throws.
    expect(
      await releaseTask(store.db, { dataRoot: store.dataRoot, deps: { runOperator } }, store.slug, "VIB-10"),
    ).toBe(true);
    await eventually(() => expect(runOperator).toHaveBeenCalled());
    await eventually(() =>
      expect(
        file(store, "VIB-10").timeline.some((e) =>
          (e.text ?? "").includes("could not be started automatically"),
        ),
      ).toBe(true),
    );
    const note = file(store, "VIB-10").timeline.find((e) =>
      (e.text ?? "").includes("could not be started automatically"),
    )!;
    const text = note.text ?? "";
    // CANARY: put "(an internal error)" back and the thrown reason is gone.
    expect(text).toContain("no runtime is deployed for claude");
    // The trigger it failed ON, because "the operator did not start" is a
    // different fact depending on what asked for it.
    expect(text).toContain("dependencies-released");
    // CANARY: restore "Coordination is paused for this task" and these fail.
    // This code knows ONE attempt failed; it cannot know nothing else will run,
    // and ruling 330's sweep guarantees something looks again.
    expect(text).not.toMatch(/coordination is paused/i);
    expect(text).toContain("not a decision to stop");
    expect(text).toContain("sweeps for tasks");
    // The manual exit survives as an option, not as the only way out.
    expect(text).toContain("Run the operator yourself");
    expect(text).not.toMatch(/run the operator manually when you'?re ready/i);
  });
});

/** Ruling 131(e): the release engine. */
describe("the release engine", () => {
  /**
   * F39-65: a chain link minted by the completion it waits on is released by
   * its mint (ruling 358). Nothing held it, so the operator's release turn is
   * told there is nothing from before a hold to bring up to date.
   */
  it("F39-65: a release at birth reaches the operator as one, and tells nobody the task can move again", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-11", {
        stage: "impl",
        waiting: "none",
        readiness: "blocked",
        blockedBy: ["VIB-2"],
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const runOperator = runOperatorStub();
    expect(
      await releaseTask(store.db, { dataRoot: store.dataRoot, deps: { runOperator } }, store.slug, "VIB-11", { atBirth: true }),
    ).toBe(true);
    await eventually(() =>
      expect(runOperator.mock.calls.some((c) => c[1].trigger === "dependencies-released")).toBe(true),
    );
    // CANARY: drop the payload's `atBirth` and the release turn tells a task
    // born a moment ago that the base "CHANGED since the hold".
    const release = runOperator.mock.calls.find((c) => c[1].trigger === "dependencies-released")!;
    expect(release[1].dependencyRelease).toEqual({ entries: ["VIB-2"], clearedBy: null, atBirth: true });
    const note = file(store, "VIB-11").timeline.find((e) => e.title === "Dependencies released")!;
    expect(note.text).toBe("Released: everything this task waits on was done before it was created (VIB-2), so nothing held it.");
    // SAFETY: COUNT(*) always answers one row, and `n` is its number.
    const told = store.db
      .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE task_key = 'VIB-11' AND kind = 'dependency'`)
      .get() as { n: number };
    expect(told.n).toBe(0);
  });

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
    await transitionStage(store.db, { projectSlug: store.slug, taskKey: "VIB-5", toStageId: "review", manual: true }, actorOf(store.users.arda), ctxWith);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(file(store, "VIB-10").frontmatter.blockedBy).toEqual(["VIB-2", "VIB-5", "VIB-1"]);
    // Both land (accepted by hand here; the acceptance path fires the same
    // hook), then ANY task write with the hook releases VIB-10: the sweep
    // reads the project's live state, not the moved task's.
    for (const key of ["VIB-5", "VIB-1"]) {
      writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, { stage: "done", waiting: "none" }) });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await transitionStage(store.db, { projectSlug: store.slug, taskKey: "VIB-4", toStageId: "review", manual: true }, actorOf(store.users.arda), ctxWith);
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
      .prepare(`SELECT user_id, kind, actor_json FROM notifications WHERE task_key = 'VIB-10' AND kind = 'dependency'`)
      .all() as { user_id: string; kind: string; actor_json: string | null }[];
    expect(notifs.map((n) => n.user_id)).toContain(store.users.arda.id);
    // Ruling 361: the inbox names the engine as the timeline does, never the
    // Operator (CANARY: drop `from` at the release site — the type refuses;
    // pass OPERATOR_NOTIFY_FROM there and this reads "Operator").
    for (const n of notifs) {
      expect(JSON.parse(n.actor_json ?? "null")).toEqual({ kind: "system", name: "Dependency release" });
    }
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
          links: [{ index: 1, title: "l1", goal: "g", taskKey: null, status: "skipped", note: null, redeclared: false, blockedBy: [] }],
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

    await setTaskArchived(store.db, { projectSlug: store.slug, taskKey: "VIB-5", archived: true }, actorOf(store.users.arda), ctxWith);
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


/**
 * F37-63: a pending link on a CANCELLED goal is dead and nothing noticed.
 *
 * Every mechanism lined up to miss it. `case "cancel"` sets only
 * `fm.status = "cancelled"` and leaves the links exactly as they were; the
 * resolver read `link.status` alone and mapped `pending` to `open`;
 * `deadDependencies` filtered `failed`/`missing`; and every goal-side remedy
 * that could rescue it (`skip_link`, `edit_link`, `retry_link`,
 * `remove_pending_link`) refuses with "Goal X is cancelled". Meanwhile
 * `releaseDependents`' own comment claimed the sweep "notices a wait that can
 * NEVER complete, whatever killed it … a cancelled goal, a removed link or a
 * lost task". It did not notice this one.
 */
describe("F37-63: a pending link on a cancelled goal is a dead wait", () => {
  it("is noted, notified and left on a human, like every other dead wait", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    // goal-1 link 2 has no task yet. Cancel the chain it belongs to.
    const { updateGoal } = await import("./goal-actions.server");
    await updateGoal(
      store.db,
      { projectSlug: store.slug, goalId: "goal-1", action: { op: "cancel" } },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-13", {
        stage: "impl",
        waiting: "none",
        readiness: "blocked",
        blockedBy: ["goal-1 link 2"],
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runOperator = runOperatorStub();
    const ctxWith = { dataRoot: store.dataRoot, deps: { runOperator } };

    // CANARY: drop the `goalTerminal` arm from the resolver and this task is
    // held forever in silence — the sweep sees `open`, writes nothing, and the
    // minute tick re-confirms it for as long as the instance runs.
    expect(await releaseDependents(store.db, ctxWith, store.slug)).not.toContain("VIB-13");
    const parsed = file(store, "VIB-13");
    const dead = parsed.timeline.filter((e) => e.title === "Waiting on work that cannot complete");
    expect(dead).toHaveLength(1);
    expect(dead[0]!.text).toContain("can never complete");
    expect(parsed.frontmatter.waiting).toBe("human");
    // The entry keeps its own cause, which is what the note points the reader
    // at ("What KILLED the entry is on the entry itself, rendered as its
    // state"). CANARY: fold `cancelled` into `failed` and the surface says
    // "archived", which is a different cause and a false one.
    const { resolveDependencies } = await import("~/server/projections/dependencies.server");
    const entries = resolveDependencies(store.db, store.slug, ["goal-1 link 2"]);
    expect(entries[0]!.state).toBe("cancelled");
  });

  it("a live chain's pending link is still just open", async () => {
    // The gate keys on the GOAL's status, so an ordinary wait must not become
    // dead. CANARY: treat every taskless pending link as cancelled.
    const store = setupTestStore(ctx);
    await seed(store);
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const { resolveDependencies } = await import("~/server/projections/dependencies.server");
    expect(resolveDependencies(store.db, store.slug, ["goal-1 link 2"])[0]!.state).toBe("open");
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
      actorOf(store.users.arda),
      ctxWith,
    );
    expect(notes()).toHaveLength(1);
    await setTaskArchived(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-9", archived: true },
      actorOf(store.users.arda),
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

/**
 * Ruling 155 (pass 35, F35-3; amends 131(c)): once a link has started a task,
 * the task's list is the wait and the goal file's `links[].blockedBy` follows
 * it on every change, so the Goals panel and a retried link read the list
 * the task last held.
 */
describe("ruling 155: an active link's wait mirrors its task's list", () => {
  it("a person clearing the task's list clears the link's declared wait and the goal timeline names the task; a new list mirrors too; the engine's release mirrors under its own name", async () => {
    // Canary: remove the `mirrorLinkWait` calls from `setTaskDependencies`
    // and `releaseTask`; goal-3 link 1 keeps reading ["goal-1 link 2"].
    const store = setupTestStore(ctx);
    await seed(store);
    // goal-3 link 1 is ACTIVE, carried by VIB-7, and still records the wait
    // the task was born with (KNC-3's shape on 2026-09-06).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-7", {
        stage: "impl",
        waiting: "none",
        blockedBy: ["goal-1 link 2"],
        goalRef: { goalId: "goal-3", linkIndex: 1 },
      }),
    });
    await createGoalFile(
      { projectSlug: store.slug, goalId: "goal-3", dataRoot: store.dataRoot },
      {
        frontmatter: {
          id: "goal-3",
          title: "goal-3",
          status: "active",
          createdBy: store.users.arda.id,
          createdByLabel: store.users.arda.email,
          onFailure: "pause",
          links: [
            { index: 1, title: "Log view", goal: "g", taskKey: "VIB-7", status: "active", note: null, redeclared: false, blockedBy: ["goal-1 link 2"] },
            { index: 2, title: "Filters", goal: "g", taskKey: null, status: "pending", note: null, redeclared: false, blockedBy: [] },
          ],
          createdAt: null,
          updatedAt: null,
        },
        description: "",
      },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const goal = () => readGoalFile({ projectSlug: store.slug, goalId: "goal-3", dataRoot: store.dataRoot })!.parsed;
    const projected = () => {
      // SAFETY: `links_json` is TEXT NOT NULL on `goal_projections`.
      const row = store.db
        .prepare(`SELECT links_json FROM goal_projections WHERE project_slug = ? AND goal_id = ?`)
        .get(store.slug, "goal-3") as { links_json: string };
      return z.array(z.object({ blockedBy: z.array(z.string()) }).loose()).parse(JSON.parse(row.links_json));
    };
    expect(goal().frontmatter.links[0]!.blockedBy).toEqual(["goal-1 link 2"]);
    const ctxWith = { dataRoot: store.dataRoot, deps: { runOperator: runOperatorStub() } };

    // A person empties the task's list: the release, and the mirror.
    await setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-7", blockedBy: [] }, actorOf(store.users.arda), ctxWith);
    expect(file(store, "VIB-7").frontmatter.blockedBy).toEqual([]);
    expect(goal().frontmatter.links[0]!.blockedBy).toEqual([]);
    expect(goal().timeline[0]!.text).toBe(
      `Link 1 (Log view) now waits on nothing: VIB-7's list was changed by ${store.users.arda.name}.`,
    );
    // The panel reads the projection, which the mirror rebuilt.
    expect(projected()[0]!.blockedBy).toEqual([]);
    // Link 2 (pending, no task) is not touched.
    expect(goal().frontmatter.links[1]!.blockedBy).toEqual([]);

    // A new list on the task lands on the link too.
    await setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-7", blockedBy: ["VIB-5"] }, actorOf(store.users.arda), ctxWith);
    expect(goal().frontmatter.links[0]!.blockedBy).toEqual(["VIB-5"]);
    expect(goal().timeline[0]!.text).toMatch(/^Link 1 \(Log view\) now waits on VIB-5: VIB-7's list was changed by /);

    // VIB-5 finishes: the engine releases VIB-7 and the link follows, under
    // the engine's own name. (F39-63: a wait is added while its entry is open.)
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-5", { stage: "done", waiting: "none" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(await releaseTask(store.db, ctxWith, store.slug, "VIB-7")).toBe(true);
    expect(file(store, "VIB-7").frontmatter.blockedBy).toEqual([]);
    expect(goal().frontmatter.links[0]!.blockedBy).toEqual([]);
    expect(goal().timeline[0]!.text).toBe("Link 1 (Log view) now waits on nothing: VIB-7's list was changed by Viberr (release).");
    expect(projected()[0]!.blockedBy).toEqual([]);

    // Convergent: the same list again writes no second timeline line.
    const lines = goal().timeline.length;
    await setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-7", blockedBy: [] }, actorOf(store.users.arda), ctxWith);
    expect(goal().timeline.length).toBe(lines);
  });

  it("a task outside a chain, and a link no longer carried by the task, leave every goal file alone", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    // VIB-8 names goal-2 link 1 as its position, but that link is PENDING with
    // no task: the record is not this task's to write.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-8", { stage: "impl", waiting: "none", blockedBy: ["VIB-5"], goalRef: { goalId: "goal-2", linkIndex: 1 } }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const goal2 = () => readGoalFile({ projectSlug: store.slug, goalId: "goal-2", dataRoot: store.dataRoot })!;
    const before = goal2().raw;
    await setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-8", blockedBy: [] }, actorOf(store.users.arda), { dataRoot: store.dataRoot, deps: { runOperator: runOperatorStub() } });
    expect(goal2().raw).toBe(before);
    expect(goal2().parsed.frontmatter.links[0]!.blockedBy).toEqual(["goal-1 link 2"]);
  });
});

/**
 * Ruling 241 (pass 37, F37-68): the question a hold refused is put when the
 * hold lifts, and before the operator gets the task back.
 *
 * Live on SHOP-5 ruling 237's escalation recommended asking the reviewer what
 * else it would block on. The task was held (`blockedBy: [SHOP-23]`), ruling 186
 * refuses every agent dispatch while it is, and the resolution discovered that
 * only AFTER writing the decision onto the task contract and clearing the
 * packet. Nothing was asked, the packet was gone, and the contract said "no
 * rework until the reviewer has answered" about a reviewer nobody would ask.
 */
/** What the drain sends the dispatch: the contract under test, taken from the
 *  dispatch's own input type so the recorder cannot assert a shape the real
 *  function would not accept. */
type QuestionDispatch = StartAgentRunInput;

const QUESTION_RUN: StartAgentRunResult = {
  runId: "run_q",
  backend: "claude",
  role: "Code review",
  name: "rev",
  outcome: "started",
  refusal: null,
};

const recordDispatch =
  (into: QuestionDispatch[]) =>
  (_db: DatabaseSync, input: QuestionDispatch): Promise<StartAgentRunResult> => {
    into.push(input);
    return Promise.resolve(QUESTION_RUN);
  };

describe("F37-68 / ruling 241: a reviewer question the hold refused survives the wait", () => {
  function seedQueued(store: TestStore, held: string[]): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-11", {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.arda.id,
        blockedBy: held,
        engagements: [
          { profileId: "rev", backend: "claude", role: "Code review", delivers: false, verdictCapable: true },
        ],
        queuedQuestions: [
          {
            id: "qq_1",
            profileId: "rev",
            directive: "Name everything you would still block on.",
            decidedBy: store.users.arda.id,
            decidedByLabel: "Arda",
            decidedAt: "2026-09-14T17:35:15.159Z",
            heldBy: [...held],
          },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("the drain starts the reviewer with the stored question, and empties the queue first", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    seedQueued(store, []);
    const started: QuestionDispatch[] = [];
    const drained = await drainQueuedQuestions(
      store.db,
      { dataRoot: store.dataRoot, deps: { startAgentRun: recordDispatch(started) } },
      store.slug,
      "VIB-11",
    );
    {
      expect(drained).toBe(1);
      expect(started).toHaveLength(1);
      // The STORED text, not a constant rebuilt at drain time: a person was
      // promised this question and the wait can outlive the constant.
      expect(started[0]!.directive).toBe("Name everything you would still block on.");
      expect(started[0]!.profileId).toBe("rev");
      expect(started[0]!.directiveFrom).toBe("Arda");
      // CANARY: drain without clearing and the next release asks the same
      // reviewer the same question again, which is the loop ruling 237 breaks.
      expect(file(store, "VIB-11").frontmatter.queuedQuestions).toEqual([]);
    }
  });

  it("a start that fails after the release says so, and does not leave the question queued", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    seedQueued(store, []);
    await drainQueuedQuestions(
      store.db,
      {
        dataRoot: store.dataRoot,
        deps: {
          startAgentRun: () => Promise.reject(new Error("The reviewer is no longer deployed.")),
        },
      },
      store.slug,
      "VIB-11",
    );
    {
      const parsed = file(store, "VIB-11");
      expect(parsed.frontmatter.queuedQuestions).toEqual([]);
      // F37-33: `waiting` must never claim an agent nobody started.
      expect(parsed.frontmatter.waiting).toBe("human");
      const note = parsed.timeline.find((e) => e.title === "Queued question not put")!;
      expect(note.text).toContain("The reviewer is no longer deployed.");
      expect(note.text).toContain("Nothing was asked and nothing is running.");
    }
  });

  it("the OPERATOR clearing the wait puts the question too, though no release is announced", async () => {
    // Self-review of ruling 241, an hour after shipping it. `setTaskDependencies`
    // computes `releasing` as `next.length === 0 && previous.length > 0 &&
    // !ctx.operatorAuthorized` — the operator is excluded deliberately, because
    // `announceRelease` re-invokes the operator and a write from inside its own
    // turn would loop. But the drain lived ONLY in `announceRelease`, so the
    // operator correcting a wait with `set_dependencies` (the door ruling 240
    // names by name) left the question stranded on the task forever, under a
    // wait panel still promising it would be put when the wait clears — on a
    // task with nothing left to clear. F37-68's own shape, in my own fix.
    const store = setupTestStore(ctx);
    await seed(store);
    seedQueued(store, ["VIB-2"]);
    const started: QuestionDispatch[] = [];
    await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-11", blockedBy: [] },
      actorOf(store.users.arda),
      {
        dataRoot: store.dataRoot,
        operatorAuthorized: true,
        deps: { startAgentRun: recordDispatch(started), runOperator: runOperatorStub() },
      },
    );
    expect(file(store, "VIB-11").frontmatter.blockedBy).toEqual([]);
    // CANARY: drain only inside `announceRelease` and this is 0 — the promise
    // on the wait panel outlives the wait and nothing ever puts the question.
    expect(started).toHaveLength(1);
    expect(started[0]!.profileId).toBe("rev");
    expect(file(store, "VIB-11").frontmatter.queuedQuestions).toEqual([]);
  });

  it("the release drains the question BEFORE it hands the task back to the operator", async () => {
    // Ordering is the whole point: the decision says the reviewer answers
    // before anyone reworks anything, and an operator re-invoked first can
    // dispatch that rework in the window between the two.
    const store = setupTestStore(ctx);
    await seed(store);
    seedQueued(store, ["VIB-2"]);
    const order: string[] = [];
    const runOperator = vi.fn((_db: DatabaseSync, _input: RunOperatorInput) => {
      order.push("operator");
      return Promise.resolve({ runId: "run_x", queued: false, backend: "claude" as const, autonomy: "supervised" as const });
    });
    {
      await announceRelease(
        store.db,
        {
          dataRoot: store.dataRoot,
          deps: {
            runOperator,
            startAgentRun: (): Promise<StartAgentRunResult> => {
              order.push("question");
              return Promise.resolve(QUESTION_RUN);
            },
          },
        },
        store.slug,
        "VIB-11",
        { entries: ["VIB-2"] },
      );
      await eventually(() => expect(order).toContain("operator"));
      // CANARY: move the drain below the `autoInvokeOperator` call and this
      // reads ["operator", "question"].
      expect(order).toEqual(["question", "operator"]);
    }
  });
});

/**
 * U39-18 (pass 39): a person, in a sentence people read, is named. Live on
 * AX-20: "Released: arda@viberr.dev · via controller cleared the wait on
 * AX-22", and the goal history said "edited by arda@viberr.dev · via
 * controller".
 */
describe("U39-18: actorProseName", () => {
  it("names the person, says the controller in words, and leaves an unknown label alone", async () => {
    // CANARY: return `actor.label` from `actorProseName`.
    const { actorProseName } = await import("./user-display-name.server");
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    expect(actorProseName(store.db, { userId: arda.id, label: arda.email })).toBe(arda.name);
    expect(actorProseName(store.db, { userId: arda.id, label: `${arda.email} · via controller` })).toBe(
      `${arda.name} (via the controller)`,
    );
    expect(actorProseName(store.db, { userId: "u_nobody", label: "ghost@viberr.test" })).toBe("ghost@viberr.test");
  });
});
