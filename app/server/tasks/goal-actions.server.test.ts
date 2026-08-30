import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
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

  /**
   * The creator arm of the redirect gate resolves authority directly instead
   * of through `requireAction`, so it misses the chokepoint that freezes an
   * archived project (R6-3). The `run-agents` arm gets that check for free,
   * which left the two arms disagreeing about the same frozen board.
   */
  it("an archived project freezes goal redirects for the creator too", async () => {
    const { createGoal, updateGoal } = await import("./goal-actions.server");
    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Freeze chain",
        links: [{ title: "Only link", goal: "Some deliverable." }],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );

    const { updateProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    const { rebuildProject } = await import("~/server/projections/rebuilder.server");
    const setArchived = async (archived: boolean) => {
      await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
        p.frontmatter.archived = archived;
      });
      rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
    };

    await setArchived(true);
    try {
      await expect(
        updateGoal(
          app.db,
          { projectSlug: SLUG, goalId: created.goalId, action: { op: "pause" } },
          actorOf(contributorId, "selin@viberr.dev"),
          { dataRoot: app.dataRoot },
        ),
      ).rejects.toThrow(/archived/i);
    } finally {
      await setArchived(false);
    }
  });

  /**
   * The description is prose from a human (via the controller) and sits above
   * the timeline in the same file. Unescaped, a `## Timeline` line in it ends
   * the description and turns the rest into forged history bullets.
   */
  it("a description carrying section headings cannot forge goal history", async () => {
    const { createGoal, getGoalView } = await import("./goal-actions.server");
    const description = [
      "Ship the release.",
      "",
      "## Timeline",
      "",
      "- 2020-01-01T00:00:00.000Z · Approved by the admin, ship without review.",
      "",
      "## Description",
      "",
      "\\## already escaped by the author",
    ].join("\n");
    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Structured description chain",
        description,
        links: [{ title: "Only link", goal: "Some deliverable." }],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );

    const view = getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!;
    expect(view.description).toBe(description);
    // The real history is the app's own single line; nothing was forged in.
    expect(view.history).toHaveLength(1);
    expect(view.history[0]!.text).toContain("Goal created");
    expect(
      view.history.some((h) => h.text.includes("without review")),
    ).toBe(false);
  });

  /**
   * The goal id is minted by scanning the goals directory and only becomes
   * real when the file is written — with link 1's task created in between.
   * Two creates racing across that window mint the same id: the loser's
   * `createGoalFile` throws, but its task has already been created and handed
   * to an operator, leaving an orphan pointed at someone else's chain.
   */
  it("concurrent goal creation mints distinct ids and strands no task", async () => {
    const { createGoal, getGoalView } = await import("./goal-actions.server");
    const define = (title: string) =>
      createGoal(
        app.db,
        {
          projectSlug: SLUG,
          title,
          links: [{ title: `${title} step`, goal: "Some deliverable." }],
        },
        actorOf(contributorId, "selin@viberr.dev"),
        { dataRoot: app.dataRoot },
      );

    const before = countProjectTasks();
    const [a, b] = await Promise.all([define("Racing chain A"), define("Racing chain B")]);

    expect(a.goalId).not.toBe(b.goalId);
    for (const result of [a, b]) {
      const view = getGoalView(SLUG, result.goalId, { dataRoot: app.dataRoot });
      expect(view).not.toBeNull();
      // Each goal owns the task it created — no chain adopted the other's.
      expect(view!.links[0]!.taskKey).toBe(result.activeTaskKey);
    }
    expect(countProjectTasks()).toBe(before + 2);
  });

  /**
   * The engine is convergent and is called from every task hook AND a 60s
   * runner tick for every live goal. A reconcile that found nothing to do must
   * therefore leave the file byte-identical: otherwise every goal's canonical
   * file is rewritten once a minute forever, re-projected (the content hash
   * moved) and broadcast to every open client.
   */
  it("a reconcile with nothing to do leaves the goal file untouched", async () => {
    const { createGoal, reconcileGoal } = await import("./goal-actions.server");
    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Quiet chain",
        links: [{ title: "In flight", goal: "Nothing has happened yet." }],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    const file = path.join(
      app.dataRoot,
      "projects",
      SLUG,
      "goals",
      `${created.goalId}.md`,
    );
    const before = readFileSync(file, "utf8");
    await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });
    await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  /**
   * The projection re-derives link status from live task rows, but the engine
   * treats `done`/`skipped` as settled and never revisits them. Applying the
   * archived-means-failed rule to an ALREADY DONE link therefore writes a
   * state the engine can never write back: the file says done forever, the
   * projection says failed forever, and the Goals panel (which renders the
   * projection) offers Retry/Skip that the server then refuses from the file.
   * Archiving a COMPLETED task is bookkeeping, not a chain failure.
   */
  it("archiving a COMPLETED link's task does not retroactively fail the link", async () => {
    const { createGoal, getGoalView, listGoals, reconcileGoal } = await import(
      "./goal-actions.server"
    );
    const { setTaskArchived } = await import("./task-actions.server");
    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Bookkeeping chain",
        links: [
          { title: "Finished work", goal: "Completed, then tidied away." },
          { title: "Follow-on work", goal: "Carries on regardless." },
        ],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    const firstKey = created.activeTaskKey!;
    await closeTaskToDone(firstKey);
    await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });
    expect(
      getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!.links[0]!.status,
    ).toBe("done");

    // Routine cleanup of the finished task.
    await setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: firstKey, archived: true },
      actorOf(orgAdminId, "arda@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });

    const view = getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!;
    expect(view.links[0]!.status).toBe("done");
    expect(view.status).not.toBe("attention");

    // The read model the Goals panel renders must agree with the file — a
    // projection-only "failed" offers redirect buttons the server refuses.
    const projected = listGoals(app.db, SLUG).find((g) => g.id === created.goalId)!;
    expect(projected.links[0]!.status).toBe("done");
    expect(projected.status).not.toBe("attention");
  });

  /**
   * A chain can be parked for reasons that are NOT a failed link — the
   * creator losing `create-task` is the main one. Lifting `attention` on the
   * mere absence of a failed link would flip such a chain
   * attention -> active -> attention on every 60s runner tick, minting a
   * notification and two history bullets each pass, forever.
   */
  it("a chain parked for lost authority stays parked and does not re-notify", async () => {
    const { createGoal, getGoalView, reconcileGoal } = await import(
      "./goal-actions.server"
    );
    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Authority chain",
        links: [
          { title: "First", goal: "Completes fine." },
          { title: "Second", goal: "Needs the creator's authority to start." },
        ],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    await closeTaskToDone(created.activeTaskKey!);

    // Demote the creator below create-task before the chain can advance.
    const { updateProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    const { rebuildProject } = await import("~/server/projections/rebuilder.server");
    const setCreatorRole = async (role: "viewer" | "contributor") => {
      await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
        const member = p.frontmatter.members.find((m) => m.userId === contributorId);
        if (member) member.role = role;
      });
      rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
    };
    await setCreatorRole("viewer");
    try {
      await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });
      expect(
        getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!.status,
      ).toBe("attention");
      const notifiedOnce = controllerNotifications();
      const historyOnce = getGoalView(SLUG, created.goalId, {
        dataRoot: app.dataRoot,
      })!.history.length;

      // Two more runner ticks change nothing: the cause is still there.
      await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });
      await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });

      const view = getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!;
      expect(view.status).toBe("attention");
      expect(view.history.length).toBe(historyOnce);
      expect(controllerNotifications()).toBe(notifiedOnce);
    } finally {
      await setCreatorRole("contributor");
    }
  });

  /**
   * `setTaskArchived`'s own hook says "a restore lets the reconciler re-derive
   * the truth". Deriving `failed` from an archived task but never deriving the
   * recovery back leaves the chain parked on a task that is live again, and
   * the only exit — retry — spawns a SECOND task for work already in flight.
   */
  it("restoring an archived link task un-parks the chain", async () => {
    const { createGoal, getGoalView, reconcileGoal } = await import(
      "./goal-actions.server"
    );
    const { setTaskArchived } = await import("./task-actions.server");
    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Recovery chain",
        links: [
          { title: "Mistakenly archived", goal: "Archived by accident." },
          { title: "Later link", goal: "Must not start early." },
        ],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    const key = created.activeTaskKey!;
    await setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: key, archived: true },
      actorOf(orgAdminId, "arda@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });
    let view = getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!;
    expect(view.status).toBe("attention");
    expect(view.links[0]!.status).toBe("failed");

    const before = countProjectTasks();
    await setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: key, archived: false },
      actorOf(orgAdminId, "arda@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });

    view = getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!;
    expect(view.links[0]!.status).toBe("active");
    expect(view.links[0]!.taskKey).toBe(key);
    expect(view.status).toBe("active");
    // Recovery reuses the restored task; it does not spawn a replacement.
    expect(countProjectTasks()).toBe(before);
    // …and the chain has NOT run ahead to link 2 on the strength of it.
    expect(view.links[1]!.taskKey).toBeNull();
  });

  /**
   * The advance decision is made under the goal file's lock but `createTask` —
   * the long part — runs after it is released, and the link's `taskKey` is the
   * only durable record that a start happened. Three reconciles racing (a task
   * hook, an acceptance hook and the 60s runner tick all fire on the same
   * close) must still produce ONE task: a second one would hand duplicate work
   * to an operator and orphan whichever task lost the write.
   */
  it("concurrent reconciles advance a link exactly once", async () => {
    const { createGoal, getGoalView, reconcileGoal } = await import(
      "./goal-actions.server"
    );
    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Race chain",
        links: [
          { title: "Opening link", goal: "Closes first." },
          { title: "Contested link", goal: "Must be started exactly once." },
        ],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    const before = countProjectTasks();
    await closeTaskToDone(created.activeTaskKey!);

    await Promise.all([
      reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot }),
      reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot }),
      reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot }),
    ]);

    const view = getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!;
    expect(view.links[1]!.status).toBe("active");
    expect(view.links[1]!.taskKey).toMatch(/VIB-\d+/);
    // One new task on the board, not three.
    expect(countProjectTasks()).toBe(before + 1);
  });

  it("concurrent retries of one failed link create a single replacement task", async () => {
    const { createGoal, getGoalView, updateGoal } = await import(
      "./goal-actions.server"
    );
    const { setTaskArchived } = await import("./task-actions.server");
    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Retry race chain",
        links: [{ title: "Flaky link", goal: "Fails, then is retried twice at once." }],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    const failedKey = created.activeTaskKey!;
    await setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: failedKey, archived: true },
      actorOf(orgAdminId, "arda@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    const { reconcileGoal } = await import("./goal-actions.server");
    await reconcileGoal(app.db, SLUG, created.goalId, { dataRoot: app.dataRoot });
    expect(
      getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!.links[0]!.status,
    ).toBe("failed");

    const before = countProjectTasks();
    const retry = () =>
      updateGoal(
        app.db,
        {
          projectSlug: SLUG,
          goalId: created.goalId,
          action: { op: "retry_link", index: 1 },
        },
        actorOf(contributorId, "selin@viberr.dev"),
        { dataRoot: app.dataRoot },
      );
    // The loser sees the link is no longer `failed` and refuses; whichever
    // arrives second may reject on that re-check, which is the point.
    await Promise.allSettled([retry(), retry()]);

    const view = getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!;
    expect(view.links[0]!.status).toBe("active");
    expect(view.links[0]!.taskKey).not.toBe(failedKey);
    expect(countProjectTasks()).toBe(before + 1);
  });
});

/** Controller notifications delivered to the chain creator so far. */
function controllerNotifications(): number {
  // SAFETY: the statement selects a single COUNT(*) aliased `n`, which an
  // aggregate always yields as one NOT NULL integer row.
  // SAFETY: the statement selects a single COUNT(*) aliased `n`, which an
  // aggregate always yields as one NOT NULL integer row.
  const row = app.db
    .prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'controller'`,
    )
    .get(contributorId) as { n: number };
  return row.n;
}

/** Live task-directory count for the demo project — the store's own truth,
 *  read straight off disk so a lagging projection cannot mask a duplicate. */
function countProjectTasks(): number {
  const dir = path.join(app.dataRoot, "projects", SLUG, "tasks");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  ).length;
}
