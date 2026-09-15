import { existsSync, readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import { goalLinkSchema } from "~/schemas/goal-file.schema";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { RunOperatorInput } from "~/server/runtimes/operator-run.server";
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

describe("ruling 131(c): chain-created tasks inherit the link's declared wait", () => {
  it("goal-2's link 1 declares a wait on goal-1 link 2: the created task carries it, waiting is none, the history says so, the create trigger is handed over (and refused, A12); a wait that can no longer be satisfied parks the chain", async () => {
    // Canaries: drop `blockedBy` from `startLinkTaskLocked`'s createTask
    // input (link 2's task is born free); swallow the validation error in
    // `startLinkTask`'s catch (the chain never parks).
    const { createGoal, getGoalView } = await import("./goal-actions.server");
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const { setTaskArchived } = await import("./task-actions.server");
    const runOperator = vi.fn((_db: DatabaseSync, _input: RunOperatorInput) =>
      Promise.resolve({ runId: "run_x", queued: false, backend: "claude" as const, autonomy: "supervised" as const }),
    );
    const ctx = { dataRoot: app.dataRoot, deps: { runOperator } };
    // The demo seed deploys no operator; `autoInvokeOperator` returns early
    // without one, so deploy one for the hand-over to have a seam to reach.
    const { readProjectFile, updateProjectFile } = await import("~/server/files/project-writer.server");
    const pf = readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!;
    if (!pf.parsed.frontmatter.agents.some((a) => a.profileId === "operator")) {
      await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (proj) => {
        proj.frontmatter.agents.push({
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: { kind: "operator", name: "Operator", role: "Task coordinator", backends: ["claude"], model: "sonnet", autonomy: "supervised" },
        });
      });
      const { rebuildProject } = await import("~/server/projections/rebuilder.server");
      rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
    }
    const goal1 = await createGoal(
      app.db,
      { projectSlug: SLUG, title: "Foundation", links: [{ title: "Base A", goal: "A. Done when merged." }, { title: "Base B", goal: "B. Done when merged." }] },
      actorOf(contributorId, "selin@viberr.dev"),
      ctx,
    );
    const goal2 = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Dependent",
        links: [
          { title: "Needs base B", goal: "C. Done when merged.", blockedBy: [`${goal1.goalId} link 2`] },
          { title: "Needs base A", goal: "D. Done when merged.", blockedBy: [`${goal1.goalId} link 1`] },
        ],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      ctx,
    );
    const first = readTaskFile({ projectSlug: SLUG, taskKey: goal2.activeTaskKey!, dataRoot: app.dataRoot })!.parsed;
    expect(first.frontmatter.blockedBy).toEqual([`${goal1.goalId} link 2`]);
    expect(first.frontmatter.waiting).toBe("none");
    expect(first.timeline.some((e) => e.title === "Waits on other work")).toBe(true);
    // The hand-over is fire-and-forget behind a dynamic import: poll for it.
    const deadline = Date.now() + 4000;
    while (!runOperator.mock.calls.some((c) => c[1].taskKey === goal2.activeTaskKey && c[1].trigger === "create")) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const handed = runOperator.mock.calls.find((c) => c[1].taskKey === goal2.activeTaskKey && c[1].trigger === "create");
    expect(handed, "the create trigger reached the seam (its refusal is A12's real-runOperator test)").toBeDefined();
    // A declared wait on a later link of the SAME chain is refused at declaration.
    await expect(
      createGoal(
        app.db,
        { projectSlug: SLUG, title: "Backwards", links: [{ title: "L1", goal: "x", blockedBy: ["goal-999 link 1"] }] },
        actorOf(contributorId, "selin@viberr.dev"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("goal-999 is not a goal in this project") });

    // Link 2 of goal-2 waits on goal-1 link 1 = goal1's first task. Archive
    // that task, then complete goal-2 link 1 by hand: the chain tries to start
    // link 2, the wait can never be satisfied, and the chain parks.
    await setTaskArchived(app.db, { projectSlug: SLUG, taskKey: goal1.activeTaskKey!, archived: true }, actorOf(orgAdminId, "arda@viberr.dev"), ctx);
    await closeTaskToDone(goal2.activeTaskKey!);
    const { reconcileGoal } = await import("./goal-actions.server");
    await reconcileGoal(app.db, SLUG, goal2.goalId, ctx);
    const parked = getGoalView(SLUG, goal2.goalId, ctx)!;
    expect(parked.status).toBe("attention");
    expect(parked.history.some((h) => /Chain paused \(attention\): creating the next link's task failed \(.*is archived/.test(h.text))).toBe(true);
    expect(parked.links[1]!.taskKey).toBeNull();
  });
});

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

/**
 * R99 / bug-sweep #13: a retry un-parks the chain (attention→active) and records
 * "retried" BEFORE the fresh task is created. If creation is refused, the chain
 * must re-park to attention with an honest note — not sit active with a still
 * -failed link for the next 60s reconcile to flap back (a spurious re-notify and
 * a transcript claiming a retry that never started).
 */
describe("chained goals — retry re-parks when its task cannot be created", () => {
  it("a refused retry re-parks to attention instead of leaving the chain active", async () => {
    const { createGoal, getGoalView, reconcileGoal, updateGoal } = await import(
      "./goal-actions.server"
    );
    const { updateProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    const { rebuildTaskFile } = await import(
      "~/server/projections/rebuilder.server"
    );

    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Retry re-park",
        description: "Two links.",
        links: [
          { title: "One", goal: "First. Done when merged." },
          { title: "Two", goal: "Second. Done when merged." },
        ],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    const gid = created.goalId;

    // Advance to link 2, then FAIL it by archiving its task → chain parks.
    await closeTaskToDone(created.activeTaskKey!);
    await reconcileGoal(app.db, SLUG, gid, { dataRoot: app.dataRoot });
    const link2Task = getGoalView(SLUG, gid, { dataRoot: app.dataRoot })!.links[1]!
      .taskKey!;
    await updateTaskFile(
      { projectSlug: SLUG, taskKey: link2Task, dataRoot: app.dataRoot },
      (p) => {
        p.frontmatter.archived = true;
      },
    );
    rebuildTaskFile(app.db, SLUG, link2Task, { dataRoot: app.dataRoot });
    await reconcileGoal(app.db, SLUG, gid, { dataRoot: app.dataRoot });
    expect(getGoalView(SLUG, gid, { dataRoot: app.dataRoot })!.status).toBe(
      "attention",
    );

    // Demote the creator to viewer: retry_link still passes (creator arm =
    // any-member), but createTask's `create-task` check refuses the fresh task.
    await updateProjectFile(
      { projectSlug: SLUG, dataRoot: app.dataRoot },
      (p) => {
        p.frontmatter.members.find((m) => m.userId === contributorId)!.role =
          "viewer";
      },
    );
    try {
      const result = await updateGoal(
        app.db,
        { projectSlug: SLUG, goalId: gid, action: { op: "retry_link", index: 2 } },
        actorOf(contributorId, "selin@viberr.dev"),
        { dataRoot: app.dataRoot },
      );
      // The chain must be re-parked, not left active with a failed link.
      expect(result.status).toBe("attention");
      const after = getGoalView(SLUG, gid, { dataRoot: app.dataRoot })!;
      expect(after.status).toBe("attention");
      expect(after.links[1]!.status).toBe("failed");
    } finally {
      await updateProjectFile(
        { projectSlug: SLUG, dataRoot: app.dataRoot },
        (p) => {
          p.frontmatter.members.find((m) => m.userId === contributorId)!.role =
            "contributor";
        },
      );
    }
  });
});

/**
 * Pass 34 review (ruling 131's projection half): `goal_projections.links_json`
 * is only rewritten when the goal file's content hash changes, so an existing
 * store's rows carry links written before `blockedBy` existed — and the
 * Controller page reads `l.blockedBy.length` off exactly those rows.
 */
describe("listGoals parses stored links instead of asserting their shape", () => {
  it("a row written before ruling 131 reads blockedBy as an empty list, not undefined", async () => {
    // Canary: restore `links = decoded as GoalLink[]` — `blockedBy` comes back
    // undefined and the Controller page's `l.blockedBy.length` throws.
    const { createGoal, listGoals } = await import("./goal-actions.server");
    const goal = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Chain with a pre-131 projection row",
        links: [
          { title: "First", goal: "First. Done when merged." },
          { title: "Second", goal: "Second. Done when merged." },
        ],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );
    // SAFETY: the projection row exists (the goal was just created) and
    // `links_json` is NOT NULL with a '[]' default, so this SELECT answers one
    // row with that one string column.
    const row = app.db
      .prepare(`SELECT links_json FROM goal_projections WHERE goal_id = ?`)
      .get(goal.goalId) as { links_json: string };
    // The pre-ruling row shape: the same links with the key that did not exist
    // yet removed. Parsed with the schema that tolerates its absence, so this
    // fixture cannot drift from what the reader accepts.
    const legacy = z
      .array(goalLinkSchema)
      .parse(JSON.parse(row.links_json))
      .map(({ blockedBy: _dropped, ...rest }) => rest);
    app.db
      .prepare(`UPDATE goal_projections SET links_json = ? WHERE goal_id = ?`)
      .run(JSON.stringify(legacy), goal.goalId);

    const read = listGoals(app.db, SLUG).find((g) => g.id === goal.goalId)!;
    expect(read.links.length).toBeGreaterThan(0);
    for (const link of read.links) {
      expect(link.blockedBy).toEqual([]);
      expect(link.blockedBy.length).toBe(0);
    }
  });
});

/**
 * Pass 34 review (ruling 131 + the chain editor): a goal-link dependency is
 * stored BY INDEX, and `remove_pending_link` renumbers every later link — so a
 * removal used to silently re-point or orphan every reference to them.
 */
/**
 * Ruling 243 (pass 37, F37-72): a pending link can ADOPT a task that already
 * exists.
 *
 * A chain normally makes its own task when it advances, and nothing could point
 * a link at work created ahead of it. Live this pass a person asked the
 * controller to build out the tasks for three pending links; it created them,
 * and the links still read `taskKey: null`, so the chain would have created its
 * own duplicates on the next advance. The only escape was
 * `remove_pending_link`, which destroys the link's authored text — those three
 * carried the orders service's port, its whole migration schema and a
 * crash-resumption assertion, and every line had to be hand-copied into the new
 * tasks before the links could go.
 */
describe("ruling 243: a pending link adopts an existing task", () => {
  async function chainAndTask() {
    const { createGoal } = await import("./goal-actions.server");
    const { createTask } = await import("./task-actions.server");
    const actor = actorOf(contributorId, "selin@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const goal = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Chain with work made ahead of it",
        links: [
          { title: "One", goal: "One. Done when merged." },
          { title: "Two", goal: "Two. Done when merged." },
        ],
      },
      actor,
      ctx,
    );
    const made = await createTask(
      app.db,
      { projectSlug: SLUG, title: "Built before the chain got there" },
      actor,
      ctx,
    );
    return { goal, made, actor, ctx };
  }

  it("binds both records: the link carries the task and the task names the link", async () => {
    const { updateGoal } = await import("./goal-actions.server");
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const { readGoalFile } = await import("~/server/files/goal-writer.server");
    const { goal, made, actor, ctx } = await chainAndTask();

    // CANARY: delete the `adopt_task` arm and this throws on an unknown op.
    await updateGoal(
      app.db,
      { projectSlug: SLUG, goalId: goal.goalId, action: { op: "adopt_task", index: 2, taskKey: made.key } },
      actor,
      ctx,
    );

    const link = readGoalFile({ projectSlug: SLUG, goalId: goal.goalId, dataRoot: app.dataRoot })!
      .parsed.frontmatter.links.find((l) => l.index === 2)!;
    expect(link.taskKey).toBe(made.key);
    expect(link.status).toBe("active");
    // CANARY: drop the `forward.adopted` write-back and the link claims the task
    // while the task denies it — the worse of the two half-states.
    const fm = readTaskFile({ projectSlug: SLUG, taskKey: made.key, dataRoot: app.dataRoot })!
      .parsed.frontmatter;
    expect(fm.goalRef).toEqual({ goalId: goal.goalId, linkIndex: 2 });
  });

  it("refuses a task another chain already carries, naming that chain", async () => {
    const { updateGoal } = await import("./goal-actions.server");
    const { goal, made, actor, ctx } = await chainAndTask();
    await updateGoal(
      app.db,
      { projectSlug: SLUG, goalId: goal.goalId, action: { op: "adopt_task", index: 2, taskKey: made.key } },
      actor,
      ctx,
    );
    // A second chain reaching for the same task. CANARY: drop the `goalRef`
    // guard and two chains each advance on one task's completion, while the
    // task's own `goalRef` can name only one of them.
    const { createGoal } = await import("./goal-actions.server");
    const other = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Second chain",
        // Two links: createGoal starts link 1 at once, so the PENDING link 2 is
        // the one that can reach for an already-carried task.
        links: [
          { title: "Another link", goal: "Another. Done when merged." },
          { title: "Reaches for a carried task", goal: "Reach. Done when merged." },
        ],
      },
      actor,
      ctx,
    );
    await expect(
      updateGoal(
        app.db,
        { projectSlug: SLUG, goalId: other.goalId, action: { op: "adopt_task", index: 2, taskKey: made.key } },
        actor,
        ctx,
      ),
    ).rejects.toThrow(new RegExp(`already carried by ${goal.goalId} link 2`));
  });

  it("refuses a link that already has a task, and an archived one", async () => {
    const { updateGoal } = await import("./goal-actions.server");
    const { setTaskArchived } = await import("./task-actions.server");
    const { goal, made, actor, ctx } = await chainAndTask();
    // Link 1 is ACTIVE with its own chain-made task.
    await expect(
      updateGoal(
        app.db,
        { projectSlug: SLUG, goalId: goal.goalId, action: { op: "adopt_task", index: 1, taskKey: made.key } },
        actor,
        ctx,
      ),
    ).rejects.toThrow(/Only a pending link with no task can adopt one/);

    await setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: made.key, archived: true },
      actorOf(orgAdminId, "arda@viberr.dev"),
      ctx,
    );
    await expect(
      updateGoal(
        app.db,
        { projectSlug: SLUG, goalId: goal.goalId, action: { op: "adopt_task", index: 2, taskKey: made.key } },
        actor,
        ctx,
      ),
    ).rejects.toThrow(/archived/);
  });
});

describe("remove_pending_link refuses to renumber under a live reference", () => {
  it("refuses while a TASK waits on a link at or after it, and names the task", async () => {
    // Canary: drop the `referencesToLinksFrom` guard — the removal lands, the
    // reference denotes different work, and nothing says so.
    const { createGoal, updateGoal } = await import("./goal-actions.server");
    const { createTask } = await import("./task-actions.server");
    const actor = actorOf(contributorId, "selin@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const goal = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Chain a task waits on",
        links: [
          { title: "One", goal: "One. Done when merged." },
          { title: "Two", goal: "Two. Done when merged." },
          { title: "Three", goal: "Three. Done when merged." },
        ],
      },
      actor,
      ctx,
    );
    const waiter = await createTask(
      app.db,
      {
        projectSlug: SLUG,
        title: "Waits on the third link",
        blockedBy: [`${goal.goalId} link 3`],
      },
      actor,
      ctx,
    );
    await expect(
      updateGoal(app.db, { projectSlug: SLUG, goalId: goal.goalId, action: { op: "remove_pending_link", index: 2 } }, actor, ctx),
    ).rejects.toThrow(new RegExp(`Link 2 cannot be removed.*${waiter.key}`, "s"));

    // A link BEFORE every reference still removes: the guard is about the
    // links that would move, not about the goal having any dependents.
    const goal2 = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Chain whose first link is free",
        links: [
          { title: "One", goal: "One. Done when merged." },
          { title: "Two", goal: "Two. Done when merged." },
          { title: "Three", goal: "Three. Done when merged." },
        ],
      },
      actor,
      ctx,
    );
    await createTask(
      app.db,
      { projectSlug: SLUG, title: "Waits on link 1 of the other chain", blockedBy: [`${goal2.goalId} link 1`] },
      actor,
      ctx,
    );
    await expect(
      updateGoal(app.db, { projectSlug: SLUG, goalId: goal2.goalId, action: { op: "remove_pending_link", index: 3 } }, actor, ctx),
    ).resolves.toBeDefined();
  });
});

describe("goal link indexes stay a gapless sequence", () => {
  it("a blank-titled link leaves no hole, and add_link cannot re-mint a live index", async () => {
    // Numbering ran BEFORE the blank filter, so [A, "", C] produced indexes
    // 1 and 3 with a length of 2 — and `add_link` minted `length + 1`, i.e. a
    // SECOND index 3. Every by-index lookup (declared waits, status, the task
    // binding) then had two links it could not tell apart.
    // Canary: move `.filter` back after `.map` in createGoal, or restore
    // `fm.links.length + 1` in add_link, and the duplicate returns.
    const { createGoal, updateGoal, getGoalView } = await import(
      "./goal-actions.server"
    );
    const created = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Gapless chain",
        description: "One blank link in the middle.",
        links: [
          { title: "Link one", goal: "First deliverable. Done when merged." },
          { title: "   ", goal: "Dropped: no title." },
          { title: "Link three", goal: "Third deliverable. Done when merged." },
        ],
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );

    const after = getGoalView(SLUG, created.goalId, { dataRoot: app.dataRoot })!;
    expect(after.links.map((l) => l.index)).toEqual([1, 2]);

    await updateGoal(
      app.db,
      {
        projectSlug: SLUG,
        goalId: created.goalId,
        action: {
          op: "add_link",
          title: "Link four",
          goal: "Fourth deliverable. Done when merged.",
        },
      },
      actorOf(contributorId, "selin@viberr.dev"),
      { dataRoot: app.dataRoot },
    );

    const indexes = getGoalView(SLUG, created.goalId, {
      dataRoot: app.dataRoot,
    })!.links.map((l) => l.index);
    expect(indexes).toEqual([1, 2, 3]);
    expect(new Set(indexes).size, "no two links share an index").toBe(
      indexes.length,
    );
  });
});

describe("removing a link sees another goal's PENDING wait on it", () => {
  it("refuses while a sibling goal's not-yet-started link still waits on the removed index", async () => {
    // Ruling 131(c) waits are stored BY INDEX, so a removal renumbers whatever
    // points past it. The guard checked this goal's own links and every task's
    // blockedBy — but a sibling goal's link only becomes a task when the chain
    // reaches it, so a still-pending sibling declaration was invisible and got
    // silently re-pointed at a different link.
    // Canary: drop the `listGoals` loop from referencesToLinksFrom and the
    // removal below succeeds instead of naming the holder.
    const { createGoal, updateGoal } = await import("./goal-actions.server");
    const actor = actorOf(contributorId, "selin@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };

    const base = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Base chain",
        links: [
          { title: "Base one", goal: "One. Done when merged." },
          { title: "Base two", goal: "Two. Done when merged." },
        ],
      },
      actor,
      ctx,
    );
    // Link 2 here is PENDING — the chain has not reached it, so it has no task.
    await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Dependent chain",
        links: [
          { title: "Independent first", goal: "Runs now. Done when merged." },
          {
            title: "Waits on base two",
            goal: "Later. Done when merged.",
            blockedBy: [`${base.goalId} link 2`],
          },
        ],
      },
      actor,
      ctx,
    );

    await expect(
      updateGoal(
        app.db,
        {
          projectSlug: SLUG,
          goalId: base.goalId,
          action: { op: "remove_pending_link", index: 2 },
        },
        actor,
        ctx,
      ),
    ).rejects.toThrow(/link 2/);
  });
});

/**
 * Ruling 155 (pass 35, F35-3): `edit_link` on an ACTIVE link may change
 * `blockedBy` only, forwarded to the task's one writer, which mirrors the
 * list back onto the link; a title or goal edit is refused with the sentence
 * that names the task.
 */
describe("ruling 155: edit_link on an active link edits its wait through the task", () => {
  it("blockedBy alone clears both records; a title edit is refused naming the task", async () => {
    // Canaries: restore the pending-or-failed refusal ahead of the active arm
    // (the clear is refused with the old sentence); drop the forward after
    // the lock (the task keeps its list).
    const { createGoal, updateGoal, getGoalView } = await import("./goal-actions.server");
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const { readGoalFile } = await import("~/server/files/goal-writer.server");
    const actor = actorOf(contributorId, "selin@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const base = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Base for the wait edit",
        links: [
          { title: "Base one", goal: "One. Done when merged." },
          { title: "Base two", goal: "Two. Done when merged." },
        ],
      },
      actor,
      ctx,
    );
    const held = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Held chain",
        links: [{ title: "Log view", goal: "Held. Done when merged.", blockedBy: [`${base.goalId} link 2`] }],
      },
      actor,
      ctx,
    );
    const taskKey = held.activeTaskKey!;
    const task = () => readTaskFile({ projectSlug: SLUG, taskKey, dataRoot: app.dataRoot })!.parsed.frontmatter;
    const link = () => readGoalFile({ projectSlug: SLUG, goalId: held.goalId, dataRoot: app.dataRoot })!.parsed.frontmatter.links[0]!;
    expect(link().status).toBe("active");
    expect(task().blockedBy).toEqual([`${base.goalId} link 2`]);

    await expect(
      updateGoal(app.db, { projectSlug: SLUG, goalId: held.goalId, action: { op: "edit_link", index: 1, title: "Renamed" } }, actor, ctx),
    ).rejects.toMatchObject({
      status: 409,
      message: `Only a pending or failed link's title or goal can be edited; link 1 is active. Its wait follows ${taskKey}: pass blockedBy here or edit it on the task.`,
    });
    // Nothing without a list to forward, either.
    await expect(
      updateGoal(app.db, { projectSlug: SLUG, goalId: held.goalId, action: { op: "edit_link", index: 1 } }, actor, ctx),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("pass blockedBy here") });
    expect(link().title).toBe("Log view");

    const cleared = await updateGoal(
      app.db,
      { projectSlug: SLUG, goalId: held.goalId, action: { op: "edit_link", index: 1, blockedBy: [] } },
      actor,
      ctx,
    );
    expect(cleared.message).toBe(`Link 1 waits on nothing, through ${taskKey}.`);
    expect(task().blockedBy).toEqual([]);
    expect(link().blockedBy).toEqual([]);
    const view = getGoalView(SLUG, held.goalId, ctx)!;
    expect(view.links[0]!.blockedBy).toEqual([]);
    expect(view.history[0]!.text).toBe(`Link 1 (Log view) now waits on nothing: ${taskKey}'s list was changed by selin@viberr.dev.`);
    // The task's own record says a person cleared it (ruling 131(e)).
    const timeline = readTaskFile({ projectSlug: SLUG, taskKey, dataRoot: app.dataRoot })!.parsed.timeline;
    expect(timeline.some((e) => e.title === "Dependencies released")).toBe(true);
  });

  // Pass-35 review: forwarding the list to the task's writer alone drops the
  // chain-order rule, which only `validateLinkWait` carries. A pending later
  // link declares no edges, so no cycle closes and the wait is accepted: link 1
  // then waits on link 2, and link 2 cannot start before link 1 completes.
  // Canary: forward `op.blockedBy` unvalidated again.
  it("refuses a wait on a LATER link of the same chain, and leaves the task's list alone", async () => {
    const { createGoal, updateGoal } = await import("./goal-actions.server");
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const actor = actorOf(contributorId, "selin@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Chain that must run in order",
        links: [
          { title: "Order one", goal: "One. Done when merged." },
          { title: "Order two", goal: "Two. Done when merged." },
        ],
      },
      actor,
      ctx,
    );
    const taskKey = chain.activeTaskKey!;
    const task = () => readTaskFile({ projectSlug: SLUG, taskKey, dataRoot: app.dataRoot })!.parsed.frontmatter;
    expect(task().blockedBy).toEqual([]);

    await expect(
      updateGoal(
        app.db,
        {
          projectSlug: SLUG,
          goalId: chain.goalId,
          action: { op: "edit_link", index: 1, blockedBy: [`${chain.goalId} link 2`] },
        },
        actor,
        ctx,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("a link cannot wait on a LATER link of its own chain"),
    });
    expect(task().blockedBy).toEqual([]);
  });
});

/**
 * Ruling 192 (F37-15, live): ruling 155 freezes an ACTIVE link's title and goal
 * in the goal file while the TASK's are not frozen — a decision packet, an
 * operator edit or a person rewrites them freely. On pass 37's board the two
 * copies of SHOP-2's contract came to disagree about which task owns
 * `packages/contracts`, and a retry rebuilt the task from the frozen copy, so
 * the correction everyone had been working to was dropped without a word.
 */
describe("ruling 192: a retry carries the failed task's own contract", () => {
  it("rebuilds from the task's current goal, not the link's frozen copy, and says so", async () => {
    const { createGoal, updateGoal, getGoalView, reconcileGoal } = await import(
      "./goal-actions.server"
    );
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const { setTaskArchived, updateTaskGoal } = await import("./task-actions.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Contract drift chain",
        links: [
          { title: "Drifting link", goal: "ORIGINAL-CONTRACT: this link owns packages/contracts." },
          // A pending second link: a chain whose ONLY link has failed is fully
          // settled, and a retry on one of those is swallowed (see F37-16).
          { title: "Later link", goal: "Follows. Done when merged." },
        ],
      },
      actor,
      ctx,
    );
    const first = chain.activeTaskKey!;

    // The contract moves on while the link's copy stays frozen (ruling 155).
    await updateTaskGoal(
      app.db,
      {
        projectSlug: SLUG,
        taskKey: first,
        goal: "CORRECTED-CONTRACT-7: this task no longer owns packages/contracts.",
      },
      actor,
      ctx,
    );
    // Archiving the task fails the link and parks the chain.
    await setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: first, archived: true },
      actor,
      ctx,
    );
    await reconcileGoal(app.db, SLUG, chain.goalId, ctx);
    // `setTaskArchived` also fires a reconcile and forgets it; let that one
    // land before the retry, or it re-parks the chain mid-start (F37-16).
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(getGoalView(SLUG, chain.goalId, ctx)!.links[0]!.status).toBe("failed");

    await updateGoal(
      app.db,
      { projectSlug: SLUG, goalId: chain.goalId, action: { op: "retry_link", index: 1 } },
      actor,
      ctx,
    );
    const after = getGoalView(SLUG, chain.goalId, ctx)!;
    const retried = after.links[0]!.taskKey!;
    expect(retried).not.toBe(first);

    const fresh = readTaskFile({ projectSlug: SLUG, taskKey: retried, dataRoot: app.dataRoot })!;
    // CANARY: drop the `priorTask` read and this is ORIGINAL-CONTRACT again.
    expect(fresh.parsed.goal).toContain("CORRECTED-CONTRACT-7");
    expect(fresh.parsed.goal).not.toContain("ORIGINAL-CONTRACT");
    // The chain header is REBUILT, not stacked: exactly one of them, and it
    // carries the retry's own link count and predecessor.
    expect(fresh.parsed.goal.match(/Part of goal /g)).toHaveLength(1);
    // A silent substitution is the defect either way, so the goal's own
    // timeline records that the retry did not use the link's text.
    expect(after.history.some((h) => h.text.includes("carrying"))).toBe(true);
  });

  it("a FIRST start still uses the link's declared text — nothing to carry", async () => {
    const { createGoal, getGoalView } = await import("./goal-actions.server");
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Plain chain",
        links: [{ title: "Only link", goal: "DECLARED-TEXT-3. Done when merged." }],
      },
      actor,
      ctx,
    );
    const task = readTaskFile({
      projectSlug: SLUG,
      taskKey: chain.activeTaskKey!,
      dataRoot: app.dataRoot,
    })!;
    expect(task.parsed.goal).toContain("DECLARED-TEXT-3");
    const view = getGoalView(SLUG, chain.goalId, ctx)!;
    expect(view.history.some((h) => h.text.includes("carrying"))).toBe(false);
  });
});

/**
 * Ruling 194 (F37-16, live-caught while proving ruling 192): `startLinkTask`
 * declines silently when the chain stopped being active, and the reconcile that
 * the failing task's own archive fires is fire-and-forget — so it lands there
 * routinely. The goal timeline already said "Link N retried by X"; nothing
 * corrected it, no task existed, and the creator was never told. The THROW arm
 * beside it had carried that correction since it was written.
 */
describe("ruling 194: a retry that starts nothing says so", () => {
  it("re-parks, notes the link and records the decline instead of leaving a false retry", async () => {
    const { createGoal, updateGoal, getGoalView } = await import("./goal-actions.server");
    const { updateGoalFile } = await import("~/server/files/goal-writer.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Swallowed retry chain",
        links: [
          { title: "Failing link", goal: "One. Done when merged." },
          { title: "Later link", goal: "Two. Done when merged." },
        ],
      },
      actor,
      ctx,
    );
    const first = chain.activeTaskKey!;

    // Put the chain in exactly the state the race produces: link 1 failed with
    // its task detached, and the CHAIN not active — written directly so the
    // assertion does not depend on a fire-and-forget reconcile's timing.
    await updateGoalFile(
      { projectSlug: SLUG, goalId: chain.goalId, dataRoot: app.dataRoot },
      (goal) => {
        const link = goal.frontmatter.links[0]!;
        link.status = "failed";
        link.taskKey = null;
        goal.frontmatter.status = "attention";
        return `Link 1 failed: ${first} was archived.`;
      },
    );

    const result = await updateGoal(
      app.db,
      { projectSlug: SLUG, goalId: chain.goalId, action: { op: "retry_link", index: 1 } },
      actor,
      ctx,
    );
    const after = getGoalView(SLUG, chain.goalId, ctx)!;
    // The retry genuinely started this time (the file said `active` when the
    // start re-read it), so the guard must NOT fire on a healthy retry.
    expect(after.links[0]!.taskKey).not.toBeNull();
    expect(result.status).toBe("active");
    expect(after.history.some((h) => h.text.includes("did NOT start"))).toBe(false);
  });

  it("a chain that stops being active mid-retry records the decline, not the retry", async () => {
    const { createGoal, updateGoal, getGoalView } = await import("./goal-actions.server");
    const { updateGoalFile } = await import("~/server/files/goal-writer.server");
    const { withFileLock } = await import("~/server/files/file-mutex.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Interrupted retry chain",
        links: [
          { title: "Failing link", goal: "One. Done when merged." },
          { title: "Later link", goal: "Two. Done when merged." },
        ],
      },
      actor,
      ctx,
    );
    const first = chain.activeTaskKey!;
    const goalFile = { projectSlug: SLUG, goalId: chain.goalId, dataRoot: app.dataRoot };
    await updateGoalFile(goalFile, (goal) => {
      const link = goal.frontmatter.links[0]!;
      link.status = "failed";
      // The state `reconcileGoal` really produces: a failed link KEEPS its task
      // key — it names that task in its own note. The first version of this
      // test cleared it, which is a state the product cannot reach, and the
      // guard it was "proving" (`taskKey !== null`) therefore returned early on
      // every real path while the test stayed green over it.
      goal.frontmatter.status = "attention";
      return `Link 1 failed: ${first} was archived.`;
    });

    // Hold the START lock the retry needs, so the redirect commits (status
    // active, "retried by" in the timeline) and then waits. That is the window
    // the archive's fire-and-forget reconcile lands in, live; here it is a
    // deliberate pause rather than a race, through the product's own lock.
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = withFileLock(`goal-start:${SLUG}:${chain.goalId}:1`, () => holding);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const retry = updateGoal(
      app.db,
      { projectSlug: SLUG, goalId: chain.goalId, action: { op: "retry_link", index: 1 } },
      actor,
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    // …and while it waits, the chain stops being active.
    await updateGoalFile(goalFile, (goal) => {
      goal.frontmatter.status = "paused";
      return undefined;
    });
    release();
    await lock;
    await retry;

    const after = getGoalView(SLUG, chain.goalId, ctx)!;
    // CANARY: drop the `started === null` arm and the newest timeline entry is
    // "Link 1 (Failing link) retried by arda@viberr.dev" over a link whose task
    // is still the one that failed. CANARY 2: restore the `taskKey !== null`
    // guard and this arm never fires at all, because a failed link always has
    // one.
    expect(after.links[0]!.taskKey).toBe(first);
    expect(after.links[0]!.status).toBe("failed");
    expect(after.history.some((h) => h.text.includes("did NOT start a task"))).toBe(true);
    expect(after.links[0]!.note).toContain("The retry did not start");
  });
});

/**
 * Ruling 192, second half: the DETAIL read is what a planner acts on, and it
 * was handing back a contract the work had moved past with nothing saying so.
 */
describe("ruling 192: getGoalView carries the task's live goal beside the declared one", () => {
  it("adds `liveGoal` only when the task's goal has actually moved", async () => {
    const { createGoal, getGoalView } = await import("./goal-actions.server");
    const { updateTaskGoal } = await import("./task-actions.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Live contract chain",
        links: [
          { title: "Declared title", goal: "DECLARED-GOAL-9. Done when merged." },
          { title: "Untouched link", goal: "Stays as declared." },
        ],
      },
      actor,
      ctx,
    );
    // Nothing has moved yet: no `liveGoal` anywhere.
    const fresh = getGoalView(SLUG, chain.goalId, ctx)!;
    expect(fresh.links[0]!.liveGoal).toBeUndefined();
    expect(fresh.links[1]!.liveGoal).toBeUndefined();

    await updateTaskGoal(
      app.db,
      {
        projectSlug: SLUG,
        taskKey: chain.activeTaskKey!,
        goal: "MOVED-GOAL-4: ownership changed hands.",
      },
      actor,
      ctx,
    );
    const after = getGoalView(SLUG, chain.goalId, ctx)!;
    // CANARY: drop the `liveGoal` mapping and a planner reads DECLARED-GOAL-9
    // as the current contract, which is what happened live on goal-2 link 1.
    expect(after.links[0]!.liveGoal).toBe("MOVED-GOAL-4: ownership changed hands.");
    // The declared text is NOT overwritten — it is what the chain declared and
    // what the history and the link record mean.
    expect(after.links[0]!.title).toBe("Declared title");
    expect(after.links[0]!.goal).toContain("DECLARED-GOAL-9");
    // A link with no task of its own has nothing live to report.
    expect(after.links[1]!.liveGoal).toBeUndefined();
  });
});

/**
 * Ruling 192, third half: a chain outlives the sentence it was created with.
 * Pass 37's `goal-2` still read "Identity and Catalog services" hours after
 * catalog moved to its own chain, and the only correction on offer was to
 * cancel the chain and rebuild every link.
 */
describe("ruling 192: a chain can be renamed (ruling 267: a settled one too)", () => {
  it("renames the chain, rewrites the description, and says what a rename does NOT reach", async () => {
    const { createGoal, updateGoal, getGoalView } = await import("./goal-actions.server");
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Identity and Catalog services",
        description: "Both read-side foundations.",
        links: [{ title: "Only link", goal: "One. Done when merged." }],
      },
      actor,
      ctx,
    );
    await updateGoal(
      app.db,
      {
        projectSlug: SLUG,
        goalId: chain.goalId,
        action: { op: "rename", title: "Identity service", description: "Identity only now." },
      },
      actor,
      ctx,
    );
    const after = getGoalView(SLUG, chain.goalId, ctx)!;
    expect(after.title).toBe("Identity service");
    expect(after.description).toBe("Identity only now.");
    // The already-created link task keeps the old name in its chain header, and
    // the history says so rather than implying the rename reached back.
    const task = readTaskFile({
      projectSlug: SLUG,
      taskKey: chain.activeTaskKey!,
      dataRoot: app.dataRoot,
    })!;
    expect(task.parsed.goal).toContain("Identity and Catalog services");
    expect(after.history[0]!.text).toContain("keep the old name in their chain header");
  });

  it("a description-only edit does not claim anything about names", async () => {
    const { createGoal, updateGoal, getGoalView } = await import("./goal-actions.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Steady name",
        description: "Old prose.",
        links: [{ title: "Only link", goal: "One. Done when merged." }],
      },
      actor,
      ctx,
    );
    await updateGoal(
      app.db,
      {
        projectSlug: SLUG,
        goalId: chain.goalId,
        action: { op: "rename", description: "New prose." },
      },
      actor,
      ctx,
    );
    const after = getGoalView(SLUG, chain.goalId, ctx)!;
    expect(after.title).toBe("Steady name");
    expect(after.description).toBe("New prose.");
    // CANARY: append the clause unconditionally and the history tells a reader
    // the chain was renamed when only its prose moved.
    expect(after.history[0]!.text).toBe(
      "Goal description rewritten by arda@viberr.dev.",
    );
  });

  /**
   * Ruling 267 (pass 37, F37-97). Every other `update_goal` op changes what a
   * chain will DO, and a settled chain will do nothing — the terminal guard is
   * right for all of them. `rename` changes only what it is CALLED, and a
   * chain is named before the work is understood. Live: `goal-2` stayed
   * "Identity and Catalog services" after catalog moved to goal-6 and `goal-4`
   * stayed "Storefront and Admin surfaces" after admin moved to goal-7; both
   * completed, so both were permanently wrong on a record people read to learn
   * what was built, with no door anywhere to fix them.
   */
  it("ruling 267: a CANCELLED chain can still be renamed, and nothing else about it moves", async () => {
    const { createGoal, updateGoal, getGoalView } = await import("./goal-actions.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Identity and Catalog services",
        links: [{ title: "Only link", goal: "One. Done when merged." }],
      },
      actor,
      ctx,
    );
    const args = { projectSlug: SLUG, goalId: chain.goalId };
    await updateGoal(app.db, { ...args, action: { op: "cancel" } }, actor, ctx);
    expect(getGoalView(SLUG, chain.goalId, ctx)!.status).toBe("cancelled");

    // CANARY: restore `if (terminal) throw` on the rename arm and a settled
    // chain's wrong name is wrong forever.
    const renamed = await updateGoal(
      app.db,
      { ...args, action: { op: "rename", title: "Identity service" } },
      actor,
      ctx,
    );
    expect(renamed.message).toContain("renamed");
    const after = getGoalView(SLUG, chain.goalId, ctx)!;
    expect(after.title).toBe("Identity service");
    // The rename is a LABEL: the chain is still cancelled, and the history
    // records the correction rather than the record changing silently.
    expect(after.status).toBe("cancelled");
    expect(after.history.some((h) => h.text.includes("Identity service"))).toBe(true);
    // …and it says the truth about reach on a settled chain: nothing new will
    // ever carry the new name.
    expect(after.history[0]!.text).toContain("this chain is settled");

    // Every OTHER op is still refused: the guard was not loosened generally.
    for (const op of ["pause", "resume", "cancel"] as const) {
      await expect(
        updateGoal(app.db, { ...args, action: { op } }, actor, ctx),
      ).rejects.toThrow(/cancelled/);
    }
  });

  it("refuses an empty title and a rename that names nothing, and no-ops a rename that changes nothing", async () => {
    const { createGoal, updateGoal, getGoalView } = await import("./goal-actions.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Stable chain",
        links: [{ title: "Only link", goal: "One. Done when merged." }],
      },
      actor,
      ctx,
    );
    const args = { projectSlug: SLUG, goalId: chain.goalId };
    await expect(
      updateGoal(app.db, { ...args, action: { op: "rename", title: "   " } }, actor, ctx),
    ).rejects.toThrow(/title cannot be empty/i);
    await expect(
      updateGoal(app.db, { ...args, action: { op: "rename" } }, actor, ctx),
    ).rejects.toThrow(/needs a title or a description/i);
    const before = getGoalView(SLUG, chain.goalId, ctx)!;
    const same = await updateGoal(
      app.db,
      { ...args, action: { op: "rename", title: "Stable chain" } },
      actor,
      ctx,
    );
    expect(same.message).toContain("unchanged");
    expect(getGoalView(SLUG, chain.goalId, ctx)!.history).toHaveLength(before.history.length);
  });

});

/**
 * The self-review of ruling 192 found what its first draft broke: `edit_link`
 * explicitly accepts a FAILED link — "edit a pending or failed link" is in
 * `update_goal`'s own description — and carrying the failed task's text over
 * that edit discarded the one correction the product offers there, silently.
 */
describe("ruling 192(b): an edit to a FAILED link outranks the text the retry would carry", () => {
  it("retries from the re-declared link, says so, and clears the flag", async () => {
    const { createGoal, updateGoal, getGoalView, reconcileGoal } = await import(
      "./goal-actions.server"
    );
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const { setTaskArchived, updateTaskGoal } = await import("./task-actions.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Redeclared chain",
        links: [
          { title: "Drifting link", goal: "ORIGINAL-TEXT-2. Done when merged." },
          { title: "Later link", goal: "Follows." },
        ],
      },
      actor,
      ctx,
    );
    const first = chain.activeTaskKey!;
    // The task's own text moves — the case ruling 192 was written for…
    await updateTaskGoal(
      app.db,
      { projectSlug: SLUG, taskKey: first, goal: "TASK-TEXT-5: what the task ended up saying." },
      actor,
      ctx,
    );
    await setTaskArchived(app.db, { projectSlug: SLUG, taskKey: first, archived: true }, actor, ctx);
    await reconcileGoal(app.db, SLUG, chain.goalId, ctx);
    await new Promise((resolve) => setTimeout(resolve, 25));

    // …and then a person re-declares the link, which is the later instruction.
    await updateGoal(
      app.db,
      {
        projectSlug: SLUG,
        goalId: chain.goalId,
        action: { op: "edit_link", index: 1, goal: "REDECLARED-TEXT-9: do it this way instead." },
      },
      actor,
      ctx,
    );
    expect(getGoalView(SLUG, chain.goalId, ctx)!.links[0]!.redeclared).toBe(true);

    await updateGoal(
      app.db,
      { projectSlug: SLUG, goalId: chain.goalId, action: { op: "retry_link", index: 1 } },
      actor,
      ctx,
    );
    const after = getGoalView(SLUG, chain.goalId, ctx)!;
    const retried = after.links[0]!.taskKey!;
    const fresh = readTaskFile({ projectSlug: SLUG, taskKey: retried, dataRoot: app.dataRoot })!;
    // CANARY: drop `&& !link.redeclared` from the `priorTask` read and this is
    // TASK-TEXT-5 — the edit the person just made, thrown away without a word.
    expect(fresh.parsed.goal).toContain("REDECLARED-TEXT-9");
    expect(fresh.parsed.goal).not.toContain("TASK-TEXT-5");
    // The record says which source it used, in this direction too.
    expect(after.history[0]!.text).toContain("re-declared text");
    // And the flag is consumed, so the NEXT retry carries the task again.
    expect(after.links[0]!.redeclared).toBe(false);
  });

  it("a failed link nobody re-declared still carries the task's text", async () => {
    const { createGoal, updateGoal, getGoalView, reconcileGoal } = await import(
      "./goal-actions.server"
    );
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const { setTaskArchived, updateTaskGoal } = await import("./task-actions.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Untouched chain",
        links: [
          { title: "Drifting link", goal: "ORIGINAL-TEXT-3." },
          { title: "Later link", goal: "Follows." },
        ],
      },
      actor,
      ctx,
    );
    const first = chain.activeTaskKey!;
    await updateTaskGoal(
      app.db,
      { projectSlug: SLUG, taskKey: first, goal: "TASK-TEXT-8: the corrected contract." },
      actor,
      ctx,
    );
    await setTaskArchived(app.db, { projectSlug: SLUG, taskKey: first, archived: true }, actor, ctx);
    await reconcileGoal(app.db, SLUG, chain.goalId, ctx);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await updateGoal(
      app.db,
      { projectSlug: SLUG, goalId: chain.goalId, action: { op: "retry_link", index: 1 } },
      actor,
      ctx,
    );
    const after = getGoalView(SLUG, chain.goalId, ctx)!;
    const fresh = readTaskFile({
      projectSlug: SLUG,
      taskKey: after.links[0]!.taskKey!,
      dataRoot: app.dataRoot,
    })!;
    expect(fresh.parsed.goal).toContain("TASK-TEXT-8");
  });
});

/** Both found by the self-review: a link declared with no goal read as
 *  permanently drifted, and a resent title claimed a rename that never was. */
describe("ruling 192: liveGoal and the rename clause stop claiming changes that never happened", () => {
  it("a link declared with only a title is not reported as drifted", async () => {
    const { createGoal, getGoalView } = await import("./goal-actions.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Title-only chain",
        // What `add_link` with no goal produces (`prose(args.goal ?? "")`), and
        // what the schema's own `goal: z.string().default("")` allows.
        links: [{ title: "Just a title", goal: "" }],
      },
      actor,
      ctx,
    );
    expect(chain.activeTaskKey).toBeTruthy();
    // CANARY: compare against `link.goal.trim()` alone and this is the title,
    // i.e. drift announced on a link nobody touched.
    expect(getGoalView(SLUG, chain.goalId, ctx)!.links[0]!.liveGoal).toBeUndefined();
  });

  it("resending the current title with a new description claims no rename", async () => {
    const { createGoal, updateGoal, getGoalView } = await import("./goal-actions.server");
    const actor = actorOf(orgAdminId, "arda@viberr.dev");
    const ctx = { dataRoot: app.dataRoot };
    const chain = await createGoal(
      app.db,
      {
        projectSlug: SLUG,
        title: "Same name",
        description: "Before.",
        links: [{ title: "Only link", goal: "One." }],
      },
      actor,
      ctx,
    );
    await updateGoal(
      app.db,
      {
        projectSlug: SLUG,
        goalId: chain.goalId,
        // The shape a caller that echoes the whole object produces.
        action: { op: "rename", title: "Same name", description: "After." },
      },
      actor,
      ctx,
    );
    const after = getGoalView(SLUG, chain.goalId, ctx)!;
    expect(after.description).toBe("After.");
    // CANARY: derive `renamed` from `fm.title === title` again and this says
    // link tasks keep "the old name" after an edit that changed no name.
    expect(after.history[0]!.text).toBe("Goal description rewritten by arda@viberr.dev.");
  });
});
