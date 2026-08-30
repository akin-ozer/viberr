import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";

/**
 * Ruling 99 — the chained-goal lifecycle, end to end against the real store:
 * lazy task creation, server-side advancement on completion, failure parking
 * the chain for humans, redirects (skip/retry/edit/add/remove), the creator's
 * authority re-proven at every unattended advance, and convergence (a second
 * reconcile changes nothing).
 */

let app: AppTestContext;
const SLUG = "viberr-core";

let contributorId: string;
let orgAdminId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  contributorId = findUserByEmail(app.db, "selin@viberr.dev")!.id;
  orgAdminId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

function actorOf(userId: string, label: string) {
  return { userId, label };
}

/** Push a task to the terminal stage straight through the FILE (the advance
 *  engine must react to the truth however it arrived — hooks or not). */
async function closeTaskToDone(taskKey: string) {
  const { updateTaskFile } = await import("~/server/files/task-writer.server");
  await updateTaskFile(
    { projectSlug: SLUG, taskKey, dataRoot: app.dataRoot },
    (parsed) => {
      parsed.frontmatter.previousStageId = parsed.frontmatter.stage;
      parsed.frontmatter.stage = "done";
      parsed.frontmatter.waiting = "none";
    },
  );
  const { rebuildTaskFile } = await import("~/server/projections/rebuilder.server");
  rebuildTaskFile(app.db, SLUG, taskKey, { dataRoot: app.dataRoot });
}

describe("chained goals", () => {
  let goalId = "";
  let firstTask = "";

  it("createGoal creates the goal file AND link 1's task (lazily, nothing else)", async () => {
    const { createGoal } = await import("./goal-actions.server");
    const result = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Lifecycle chain",
        description: "Three links.",
        links: [
          { title: "Link one", goal: "First deliverable. Done when merged." },
          { title: "Link two", goal: "Second deliverable. Done when merged." },
          { title: "Link three", goal: "Third deliverable. Done when merged." },
        ],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    goalId = result.goalId;
    expect(result.status).toBe("active");
    expect(result.activeTaskKey).toMatch(/VIB-\d+/);
    firstTask = result.activeTaskKey!;

    const { getGoalView } = await import("./goal-actions.server");
    const view = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    expect(view.links.map((l) => l.status)).toEqual([
      "active",
      "pending",
      "pending",
    ]);
    expect(view.links[0]!.taskKey).toBe(firstTask);
    expect(view.links[1]!.taskKey).toBeNull();

    // The created task carries the back-reference and the chain context.
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const task = readTaskFile({
      projectSlug: SLUG,
      taskKey: firstTask,
      dataRoot: app.dataRoot,
    })!;
    expect(task.parsed.frontmatter.goalRef).toEqual({ goalId, linkIndex: 1 });
    expect(task.parsed.goal).toContain(goalId);
    expect(task.parsed.goal).toContain("link 1 of 3");
  });

  it("the projection row carries the reconciled chain", async () => {
    const { listGoals } = await import("./goal-actions.server");
    const rows = listGoals(app.db, SLUG);
    const row = rows.find((g) => g.id === goalId)!;
    expect(row.status).toBe("active");
    expect(row.currentIndex).toBe(1);
    expect(row.links).toHaveLength(3);
  });

  it("link 1 completing advances the chain: link 2's task is created under the creator's authority", async () => {
    await closeTaskToDone(firstTask);
    const { reconcileGoal, getGoalView } = await import("./goal-actions.server");
    await reconcileGoal(app.db, SLUG, goalId, { dataRoot: app.dataRoot });

    const view = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    expect(view.links[0]!.status).toBe("done");
    expect(view.links[1]!.status).toBe("active");
    expect(view.links[1]!.taskKey).toMatch(/VIB-\d+/);
    expect(view.status).toBe("active");

    // The new task names its predecessor.
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const next = readTaskFile({
      projectSlug: SLUG,
      taskKey: view.links[1]!.taskKey!,
      dataRoot: app.dataRoot,
    })!;
    expect(next.parsed.goal).toContain(firstTask);

    // The chain's creator was notified of the progress.
    // SAFETY: the statement selects a single COUNT(*) aliased `n`, which an
    // aggregate always yields as one NOT NULL integer row.
    const notified = app.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'controller'`,
      )
      .get(contributorId) as { n: number };
    expect(notified.n).toBeGreaterThan(0);
  });

  it("reconcile is convergent: a second pass changes nothing", async () => {
    const { reconcileGoal, getGoalView } = await import("./goal-actions.server");
    const before = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    await reconcileGoal(app.db, SLUG, goalId, { dataRoot: app.dataRoot });
    const after = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    expect(after.links).toEqual(before.links);
    expect(after.status).toBe(before.status);
  });

  it("a link's task being ARCHIVED fails the link and parks the chain in attention, notifying the creator", async () => {
    const { getGoalView, reconcileGoal } = await import("./goal-actions.server");
    const view = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    const activeTask = view.links[1]!.taskKey!;
    const { setTaskArchived } = await import("./task-actions.server");
    await setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: activeTask, archived: true },
      actorOf(orgAdminId, "arda@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    // The archive hook fires and forgets; drive the engine deterministically.
    await reconcileGoal(app.db, SLUG, goalId, { dataRoot: app.dataRoot });
    const after = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    expect(after.links[1]!.status).toBe("failed");
    expect(after.status).toBe("attention");
  });

  it("a paused-for-attention chain does NOT advance until a human redirects; RETRY creates a fresh task for the failed link", async () => {
    const { getGoalView, reconcileGoal, updateGoal } = await import(
      "./goal-actions.server"
    );
    await reconcileGoal(app.db, SLUG, goalId, { dataRoot: app.dataRoot });
    const parked = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    expect(parked.status).toBe("attention");
    expect(parked.links[2]!.taskKey).toBeNull();

    const oldTask = parked.links[1]!.taskKey!;
    const result = await updateGoal(
      app.db,
      { projectSlug: SLUG, goalId, action: { op: "retry_link", index: 2 } },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    expect(result.status).toBe("active");
    const after = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    expect(after.links[1]!.status).toBe("active");
    expect(after.links[1]!.taskKey).not.toBe(oldTask);
  });

  it("editing a PENDING link and adding/removing links reshape the chain without touching settled history", async () => {
    const { getGoalView, updateGoal } = await import("./goal-actions.server");
    const edited = await updateGoal(
      app.db,
      {
        projectSlug: SLUG,
        goalId,
        action: {
          op: "edit_link",
          index: 3,
          title: "Link three, sharpened",
          goal: "Sharper deliverable. Done when demonstrably so.",
        },
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    expect(edited.message).toContain("updated");
    const added = await updateGoal(
      app.db,
      {
        projectSlug: SLUG,
        goalId,
        action: { op: "add_link", title: "Link four", goal: "A fourth thing." },
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    expect(added.message).toContain("added");
    const removed = await updateGoal(
      app.db,
      { projectSlug: SLUG, goalId, action: { op: "remove_pending_link", index: 4 } },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    expect(removed.message).toContain("3 links");
    const view = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    expect(view.links[0]!.status).toBe("done");
    expect(view.links[2]!.title).toBe("Link three, sharpened");
  });

  it("an unattended advance RE-PROVES the creator's live authority: a demoted creator parks the chain instead of escalating", async () => {
    const { getGoalView, reconcileGoal } = await import("./goal-actions.server");
    // Close link 2's task, then demote the creator to viewer BEFORE the engine
    // reacts — the advance must refuse to create link 3's task.
    const view = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    await closeTaskToDone(view.links[1]!.taskKey!);
    const { updateProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
      const member = p.frontmatter.members.find((m) => m.userId === contributorId)!;
      member.role = "viewer";
    });
    const { rebuildProject } = await import("~/server/projections/rebuilder.server");
    rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });

    await reconcileGoal(app.db, SLUG, goalId, { dataRoot: app.dataRoot });
    const parked = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    expect(parked.links[1]!.status).toBe("done");
    expect(parked.status).toBe("attention");
    expect(parked.links[2]!.taskKey).toBeNull();
    expect(
      parked.history.some((h) => h.text.includes("no longer holds task creation")),
    ).toBe(true);

    // Restore the role; resume advances the chain again.
    await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
      const member = p.frontmatter.members.find((m) => m.userId === contributorId)!;
      member.role = "contributor";
    });
    rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
    const { updateGoal } = await import("./goal-actions.server");
    await updateGoal(
      app.db,
      { projectSlug: SLUG, goalId, action: { op: "resume" } },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    const resumed = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    expect(resumed.status).toBe("active");
    expect(resumed.links[2]!.taskKey).toMatch(/VIB-\d+/);
  });

  it("completing the last link completes the goal, and a completed goal refuses further redirects", async () => {
    const { getGoalView, reconcileGoal, updateGoal } = await import(
      "./goal-actions.server"
    );
    const view = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    await closeTaskToDone(view.links[2]!.taskKey!);
    await reconcileGoal(app.db, SLUG, goalId, { dataRoot: app.dataRoot });
    const done = getGoalView(SLUG, goalId, { dataRoot: app.dataRoot })!;
    expect(done.status).toBe("completed");
    await expect(
      updateGoal(
        app.db,
        { projectSlug: SLUG, goalId, action: { op: "pause" } },
        actorOf(contributorId, "selin@viberr.dev"),
        { dataRoot: app.dataRoot },
      ),
    ).rejects.toThrow(/completed/);
  });

  it("onFailure: continue rides past a failed link instead of parking", async () => {
    const { createGoal, getGoalView, reconcileGoal } = await import(
      "./goal-actions.server"
    );
    const { setTaskArchived } = await import("./task-actions.server");
    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Ride-through chain",
        onFailure: "continue",
        links: [
          { title: "Fragile link", goal: "May fail." },
          { title: "Sturdy link", goal: "Should still start." },
        ],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    await setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: created.activeTaskKey!, archived: true },
      actorOf(orgAdminId, "arda@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });
    const view = getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!;
    expect(view.status).toBe("active");
    expect(view.links[0]!.status).toBe("skipped");
    expect(view.links[1]!.taskKey).toMatch(/VIB-\d+/);
  });
});
