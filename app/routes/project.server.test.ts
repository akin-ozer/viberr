import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * F19-9 — the project layout loader's RAIL BADGES.
 *
 * The layout loads the board with `includeArchived: true` (the Archived filter
 * is the only way back to an archived task), and both badges counted that raw
 * list — while the two surfaces they link to exclude archived work: the board
 * header counts `liveTasks` (board-page.tsx) and `getReviewQueue` goes through
 * `listProjectTasks`, which appends `AND archived = 0`. So the rail read
 * "Review 1" over a queue reading "0 tasks at the review boundary".
 *
 * These pin the badge to the list it links to — and pin the DIRECTION too: the
 * raw board (archived included) must still be one larger, otherwise the counts
 * would agree only because nothing was archived.
 *
 * Ruling 16 stays: Done tasks are LIVE work and stay counted.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

interface RailData {
  board: {
    columns: { stage: { id: string }; tasks: { key: string; archived: boolean }[] }[];
    orphanTasks: { key: string; archived: boolean }[];
  };
  taskCount: number;
  reviewCount: number;
}

async function railCounts(): Promise<RailData> {
  const { loader } = await import("~/routes/project");
  const { cookie } = await app.cookieFor(ardaId);
  // SAFETY: the loader reads only `request` and `params.slug`; the rest of the
  // generated `Route.LoaderArgs` (the router context provider, its matches) is
  // untouched on every path this file exercises.
  return loader({
    request: app.request("/projects/viberr-core/board", { cookie }),
    params: { slug: "viberr-core" },
    context: {},
  } as never);
}

/** Every task the loader shipped, archived ones included (the raw list the
 *  badges used to count). */
function allBoardTasks(data: RailData) {
  return [...data.board.columns.flatMap((c) => c.tasks), ...data.board.orphanTasks];
}

async function writeReviewTask(key: string, archived: boolean) {
  const { baseTaskFrontmatter, writeTask } = await import(
    "../../test-support/test-store"
  );
  const { rebuildAll } = await import("~/server/projections/rebuilder.server");
  writeTask(app.dataRoot, "viberr-core", {
    frontmatter: baseTaskFrontmatter(key, {
      stage: "review",
      waiting: "human",
      archived,
    }),
  });
  rebuildAll(app.db, { dataRoot: app.dataRoot });
}

async function removeTask(key: string) {
  const { rebuildAll } = await import("~/server/projections/rebuilder.server");
  rmSync(path.join(app.dataRoot, "projects", "viberr-core", "tasks", key), {
    recursive: true,
    force: true,
  });
  rebuildAll(app.db, { dataRoot: app.dataRoot });
}

describe("F19-9: the rail badges count the tasks their surfaces list", () => {
  it("drops an archived review task from BOTH badges, and the board still ships it", async () => {
    await writeReviewTask("VIB-991", false);
    const live = await railCounts();

    await writeReviewTask("VIB-991", true);
    const archived = await railCounts();

    try {
      // Both badges shed exactly the archived task.
      expect(archived.taskCount).toBe(live.taskCount - 1);
      expect(archived.reviewCount).toBe(live.reviewCount - 1);

      // ...and NOT because the task left the payload: the board still carries
      // it (the Archived filter needs it), so the counts differ from the raw
      // list by exactly one. This is the assertion that fails if the loader
      // goes back to counting `tasks` instead of `liveTasks`.
      const raw = allBoardTasks(archived);
      expect(raw.map((t) => t.key)).toContain("VIB-991");
      expect(raw.length).toBe(archived.taskCount + 1);
      expect(raw.filter((t) => !t.archived).length).toBe(archived.taskCount);
    } finally {
      await removeTask("VIB-991");
    }
  });

  it("matches the review queue's own total — the list the badge links to", async () => {
    const { getReviewQueue } = await import(
      "~/server/projections/review-queue.server"
    );
    await writeReviewTask("VIB-992", true);
    try {
      const data = await railCounts();
      const queue = getReviewQueue(app.db, "viberr-core", {
        viewerUserId: ardaId,
      });
      // ReviewQueueData.total is documented as the "rail-badge parity" number.
      expect(data.reviewCount).toBe(queue.total);
      expect([...queue.ready, ...queue.working].map((r) => r.key)).not.toContain(
        "VIB-992",
      );
      // The archived row IS at the review stage on the board payload — the
      // exclusion is the archived predicate, not a stage mismatch.
      const reviewColumn = data.board.columns.find((c) => c.stage.id === "review")!;
      expect(reviewColumn.tasks.map((t) => t.key)).toContain("VIB-992");
    } finally {
      await removeTask("VIB-992");
    }
  });

  it("still counts Done tasks (ruling 16) — only archived work is excluded", async () => {
    const { baseTaskFrontmatter, writeTask } = await import(
      "../../test-support/test-store"
    );
    const { rebuildAll } = await import("~/server/projections/rebuilder.server");
    const before = await railCounts();
    writeTask(app.dataRoot, "viberr-core", {
      frontmatter: baseTaskFrontmatter("VIB-993", {
        stage: "done",
        waiting: "none",
        archived: false,
      }),
    });
    rebuildAll(app.db, { dataRoot: app.dataRoot });
    try {
      const after = await railCounts();
      expect(after.taskCount).toBe(before.taskCount + 1);
    } finally {
      await removeTask("VIB-993");
    }
  });
});
