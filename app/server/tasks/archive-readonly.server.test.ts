import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile, updateProjectFile } from "~/server/files/project-writer.server";
import {
  appendComment,
  createTask,
  transitionStage,
  updateTaskGoal,
} from "./task-actions.server";
import { setProjectArchived } from "~/features/project-settings/settings-actions.server";

let ctx: TestDbContext;
let store: TestStore;

const actor = (u: { id: string; email: string }) => ({ userId: u.id, label: u.email });

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review", ownerUserId: store.users.arda.id }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
});

afterEach(() => ctx.cleanup());

async function archive() {
  await updateProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }, (parsed) => {
    parsed.frontmatter.archived = true;
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

describe("archived project is read-only (R6-3)", () => {
  it("refuses createTask on an archived project (409)", async () => {
    await archive();
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "New", goal: "A goal long enough to pass validation." },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a comment on an archived project (409) — even though commenting is app-wide", async () => {
    await archive();
    await expect(
      appendComment(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", text: "hello" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a stage transition on an archived project (409)", async () => {
    await archive();
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", manual: true },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  /**
   * The task-OWNER exception (R6-2/R14-2) lets a contributor decide about
   * their own task without the maintainer tier. It short-circuits ahead of
   * `requireAction`, which is the single chokepoint enforcing the archive
   * freeze — so the exception was also skipping the freeze. Owning a task on a
   * frozen board is not a licence to close it: acceptance attempts a real
   * merge, and packet resolution starts an operator run.
   */
  it("refuses acceptance by the task OWNER on an archived project (409)", async () => {
    await updateProjectFile(
      { projectSlug: store.slug, dataRoot: store.dataRoot },
      (parsed) => {
        parsed.frontmatter.archived = true;
      },
    );
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    await updateTaskFile(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      (parsed) => {
        parsed.frontmatter.ownerUserId = store.users.selin.id;
      },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const stages = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.stages;
    const terminal = stages[stages.length - 1]!.id;

    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: terminal, manual: true },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses editing the goal on an archived project (409)", async () => {
    await archive();
    await expect(
      updateTaskGoal(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", goal: "A different goal, long enough." },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("still allows reads (the project file loads) and restore un-freezes it", async () => {
    await archive();
    // Read path works.
    expect(readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })).not.toBeNull();
    // Restore (the ONE exempt mutation).
    await setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: false },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // Mutations work again after restore.
    const created = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Now allowed", goal: "A goal long enough to pass validation." },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(created.task.key).toMatch(/^VIB-/);
  });
});
