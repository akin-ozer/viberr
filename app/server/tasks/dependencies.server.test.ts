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
import {
  announceRelease,
  clearDependencies,
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
    const runOperator = vi.fn(async () => ({ runId: "run_x", queued: false, backend: "claude" as const, autonomy: "supervised" as const }));
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
    await announceRelease(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-8", { entries: ["VIB-2", "VIB-5"] });
    const note = file(store, "VIB-8").timeline[0]!;
    expect(note.title).toBe("Dependencies released");
    expect(note.text).toContain("everything this task waited on is done (VIB-2, VIB-5)");
    expect(note.text).toContain("the base branch has changed since the hold");
    expect(note.actor).toEqual({ kind: "system", systemId: "dependency-release" });
    expect(listAuditEvents(store.db).find((e) => e.action === "task.dependencies.released")!.details).toMatchObject({ entries: ["VIB-2", "VIB-5"], clearedBy: null });
  });
});
