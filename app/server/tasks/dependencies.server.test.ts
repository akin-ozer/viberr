import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { flush } from "../../../test-support/polling";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { getTaskSummary } from "~/server/projections/task-query.server";
import type { DatabaseSync } from "node:sqlite";
import type { RunOperatorInput } from "~/server/runtimes/operator-run.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { writeProject } from "../../../test-support/test-store";
import { createTask, setTaskArchived, transitionStage } from "./task-actions.server";
import type { StartAgentRunInput, StartAgentRunResult } from "./specialist-run.server";
import {
  announceRelease,
  noteDeadDependency,
  releaseDependents,
  releaseTask,
  setTaskDependencies,
  startDependencyRunner,
  stopDependencyRunnerForTests,
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
        definition: { kind: "operator", backends: ["claude"], model: "sonnet", autonomy: "supervised" },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

const file = (store: TestStore, key: string) =>
  readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed;

describe("validateDependencyRefs", () => {
  it("refuses unparseable, self, unknown, archived and cyclic references, each by name", async () => {
    // Canary: remove the cycle walk (`cyclePath`) and the last two refusals
    // pass validation.
    const store = setupTestStore(ctx);
    await seed(store);
    const validate = (self: Parameters<typeof validateDependencyRefs>[1]["self"], entries: string[]) =>
      validateDependencyRefs(store.db, { projectSlug: store.slug, self, entries });
    const self = { kind: "task" as const, task: "VIB-1" };
    expect(() => validate(self, ["nonsense words"])).toThrow(/"nonsense words" is not a task key/);
    // Ruling 503: the goal-link spelling went with the chains.
    expect(() => validate(self, ["goal-1 link 2"])).toThrow(/"goal-1 link 2" is not a task key/);
    expect(() => validate(self, ["VIB-1"])).toThrow(/VIB-1: a task cannot wait on itself/);
    expect(() => validate(self, ["VIB-999"])).toThrow(/VIB-999 is not a task in this project/);
    expect(() => validate(self, ["VIB-3"])).toThrow(/VIB-3 is archived/);
    // VIB-4 waits on VIB-5; VIB-5 waiting on VIB-4 closes the cycle.
    expect(() => validate({ kind: "task", task: "VIB-5" }, ["VIB-4"])).toThrow(
      /Waiting on VIB-4 would close a cycle: VIB-5 waits on VIB-4 waits on VIB-5/,
    );
    // Canonical spellings, de-duplicated, blanks dropped.
    expect(validate(self, [" VIB-2 ", "VIB-05", "", "vib-2", "vib-5"])).toEqual(["VIB-2", "VIB-5"]);
  });
});

describe("setTaskDependencies", () => {
  it("writes the list, the note, the audit row and waiting: none; an unchanged list short-circuits", async () => {
    // Canary: delete the `waiting = "none"` assignment (VIB-1 stays `human`).
    const store = setupTestStore(ctx);
    await seed(store);
    const result = await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-4", "VIB-5"] },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({ changed: true, blockedBy: ["VIB-4", "VIB-5"], added: ["VIB-4", "VIB-5"], removed: [] });
    const parsed = file(store, "VIB-1");
    expect(parsed.frontmatter.blockedBy).toEqual(["VIB-4", "VIB-5"]);
    expect(parsed.frontmatter.waiting).toBe("none");
    expect(parsed.timeline[0]).toMatchObject({ type: "note", title: "Dependencies updated" });
    expect(parsed.timeline[0]!.text).toContain("Waits on VIB-4, VIB-5 (added VIB-4, VIB-5)");
    expect(result.task.readiness).toBe("blocked");
    expect(result.task.blockedBy.map((e) => [e.ref, e.state])).toEqual([
      ["VIB-4", "open"],
      ["VIB-5", "open"],
    ]);
    const rows = listAuditEvents(store.db).filter((e) => e.action === "task.dependencies.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ blockedBy: ["VIB-4", "VIB-5"], added: ["VIB-4", "VIB-5"], removed: [] });

    const again = await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-4", "vib-5"] },
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
      { projectSlug: store.slug, taskKey: "VIB-4", blockedBy: ["VIB-5", "VIB-1"] },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(kept.blockedBy).toEqual(["VIB-5", "VIB-1"]);
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
    // elif is the seeded viewer (deniz is a non-member, refused by another branch).
    await expect(
      setTaskDependencies(store.db, { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-5"] }, actorOf(store.users.elif), { dataRoot: store.dataRoot }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("Your project role (viewer)") });
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
   * L02-1 (test audit, 2026-09-27): the goal runner was the one caller that
   * released a task at birth (ruling 358, F39-65), for the links it minted, and
   * ruling 503 deleted it. A task created waiting only on finished work (the
   * controller's `create_task`, a packet's `create_task` option) stayed held
   * until the runner's minute tick, which released it as an ordinary hold: the
   * note said the base "has changed since the hold", its people were told it
   * "can move again", and the operator was told the base CHANGED, under a
   * creation note promising "Viberr releases the list at once". The creation is
   * the release's only caller, so a test that calls `releaseTask` with
   * `atBirth` itself cannot catch this.
   */
  it("L02-1: a task created waiting only on done work is released by its creation, as a release at birth", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    const runOperator = runOperatorStub();
    const ctxWith = { dataRoot: store.dataRoot, deps: { runOperator } };
    // VIB-2 is done. Selin creates the task and owns it; Arda and Murat
    // supervise it.
    const created = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Follows finished work", blockedBy: ["VIB-2"] },
      actorOf(store.users.selin),
      ctxWith,
    );
    // The dependency runner's next tick, whatever the creation left held.
    await releaseDependents(store.db, ctxWith, store.slug);
    const turns = () => runOperator.mock.calls.filter((c) => c[1].taskKey === created.key).map((c) => c[1]);
    await eventually(() => expect(turns().some((t) => t.trigger === "dependencies-released")).toBe(true));
    // SAFETY: `title` is a nullable TEXT column on `notifications`.
    const notices = store.db
      .prepare(`SELECT title FROM notifications WHERE task_key = ? AND kind = 'dependency'`)
      .all(created.key) as { title: string | null }[];
    // CANARY: drop the release from `createTask` and the tick releases the task
    // as an ordinary hold, which all four then say. Drop the payload's
    // `atBirth` and the operator alone is told the base CHANGED since the hold.
    expect({
      note: file(store, created.key).timeline.filter((e) => e.title === "Dependencies released").map((e) => e.text),
      notices: notices.map((n) => n.title),
      operator: turns().filter((t) => t.trigger === "dependencies-released").map((t) => t.dependencyRelease),
      audit: listAuditEvents(store.db, { action: "task.dependencies.released" })
        .filter((e) => e.taskKey === created.key)
        .map((e) => e.details),
    }).toEqual({
      note: ["Released: everything this task waits on was done before it was created (VIB-2), so nothing held it."],
      notices: [],
      operator: [{ entries: ["VIB-2"], clearedBy: null, atBirth: true }],
      audit: [{ entries: ["VIB-2"], clearedBy: null, atBirth: true }],
    });
    // The creation answers with the task as it stands: held by nothing.
    expect(created.task.blockedBy).toEqual([]);
    expect(created.task.readiness).toBe("input_required");
    // One hand-off. CANARY: fire `create` as well and the operator gets the new
    // task twice, since a task no longer held does not refuse `create`. The
    // flush lets that second fire-and-forget call land before the count.
    await flush();
    expect(turns().map((t) => t.trigger)).toEqual(["dependencies-released"]);
  });

  it("L02-1: a creation released at birth does not wait for the operator's run to start", async () => {
    // CANARY: await the at-birth hand-off in `announceRelease` and this
    // creation never returns, so the controller's `create_task`, a packet's
    // resolution and the boot-time conversion would wait out a first clone
    // that can take minutes.
    const store = setupTestStore(ctx);
    await seed(store);
    const runOperator = vi.fn((_db: DatabaseSync, _input: RunOperatorInput) => new Promise<never>(() => {}));
    const created = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Follows finished work", blockedBy: ["VIB-2"] },
      actorOf(store.users.selin),
      { dataRoot: store.dataRoot, deps: { runOperator } },
    );
    expect(created.task.blockedBy).toEqual([]);
    await eventually(() => expect(runOperator).toHaveBeenCalled());
  });

  it("completing the LAST dependency releases the dependent through the transition hook: list cleared, note, readiness lifted, hold cleared, waiting back on a person, watchers notified, operator re-invoked with the payload; a partial completion releases nothing", async () => {
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
    expect(note.text).toContain("the base branch has changed since the hold");
    expect(note.actor).toEqual({ kind: "system", systemId: "dependency-release" });
    // The hold's `waiting: none` goes with it: the task is someone's to move
    // again, and the stub operator runs no drive to say so, as in a project
    // with none. CANARY: drop the settle in `announceRelease` and it stays `none`.
    expect(getTaskSummary(store.db, store.slug, "VIB-10")).toMatchObject({ readiness: "ready", waiting: "human" });
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
    // Ruling 497: the row opens the release note, which says what it waited on.
    // CANARY: drop `about` from the release notice and the row opens the top.
    expect(
      new Set(
        store.db
          .prepare(`SELECT href FROM notifications WHERE task_key = 'VIB-10' AND kind = 'dependency'`)
          .all()
          .map((row) => row.href),
      ),
    ).toEqual(new Set([`/projects/${store.slug}/tasks/VIB-10#event-${note.occurredAt}`]));
    const release = runOperator.mock.calls.find((c) => c[1].trigger === "dependencies-released");
    expect(release).toBeDefined();
    expect(release![1].dependencyRelease).toEqual({ entries: ["VIB-2", "VIB-5", "VIB-1"], clearedBy: null });
    // VIB-4 (seeded waiting on VIB-5) was released by the same sweep; VIB-10's
    // own release is exactly one row, the engine's (nobody cleared it by hand).
    expect(
      listAuditEvents(store.db)
        .filter((e) => e.action === "task.dependencies.released" && e.taskKey === "VIB-10")
        .map((e) => e.details),
    ).toEqual([expect.objectContaining({ entries: ["VIB-2", "VIB-5", "VIB-1"], clearedBy: null })]);
  });

  it("a done dependency releases; an archived dependency is noted ONCE, notifies once, sets waiting: human and never releases", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-11", { stage: "impl", waiting: "none", blockedBy: ["VIB-2"] }),
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
    // the dependency runner's tick (the hand-edited task stays held). Ruling
    // 503 moved the tick from the goal runner, which it outlived.
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

    // A hand edit the hooks never saw: VIB-15 waits on the already-done VIB-2.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-15", { stage: "impl", waiting: "none", blockedBy: ["VIB-2"] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const runOperator = runOperatorStub();
    stopDependencyRunnerForTests();
    startDependencyRunner(store.db, { dataRoot: store.dataRoot, deps: { runOperator } });
    try {
      // The first tick runs at start. The re-invoke is the release's last
      // step, so waiting on it means the whole release has landed.
      await eventually(() => expect(runOperator.mock.calls.some((c) => c[1].taskKey === "VIB-15")).toBe(true));
    } finally {
      stopDependencyRunnerForTests();
    }
    expect(file(store, "VIB-15").frontmatter.blockedBy).toEqual([]);
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
 * silent forever. Ruling 503 retired the goal links; a task that is gone is
 * the case left.
 */
describe("the sweep notices a dead wait whatever killed it", () => {
  it("a reference to a task that no longer exists is noted by the ordinary sweep", async () => {
    // Canary: call `noteDeadDependency` only from the archive hook again —
    // nothing ever tells the owner this task can never move.
    const store = setupTestStore(ctx);
    await seed(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-13", {
        stage: "impl",
        waiting: "none",
        readiness: "blocked",
        blockedBy: ["VIB-99"],
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
    expect(parsed.frontmatter.blockedBy).toEqual(["VIB-99"]);
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
  function seedQueued(store: TestStore, held: string[], waiting: "human" | "agent" = "human"): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-11", {
        stage: "review",
        waiting,
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

  it("a start that fails after the release says so, and does not leave the question queued", async () => {
    const store = setupTestStore(ctx);
    await seed(store);
    // Seeded on an agent, so the failure arm's own write is what reads `human` below.
    seedQueued(store, ["VIB-2"], "agent");
    await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-11", blockedBy: [] },
      actorOf(store.users.arda),
      {
        dataRoot: store.dataRoot,
        operatorAuthorized: true,
        deps: {
          startAgentRun: () => Promise.reject(new Error("The reviewer is no longer deployed.")),
        },
      },
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
    // The STORED text, not a constant rebuilt at drain time: a person was
    // promised this question and the wait can outlive the constant.
    expect(started[0]!.directive).toBe("Name everything you would still block on.");
    expect(started[0]!.directiveFrom).toBe("Arda");
    // CANARY: drain without clearing and the next release asks the same
    // reviewer the same question again, which is the loop ruling 237 breaks.
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
