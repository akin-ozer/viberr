import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pinPerfClock } from "../../test-support/perf-clock";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import { rowsMatching, tallyServerReads } from "../../test-support/perf-counters";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 457, journeys `task-open` / `board-live` / `server`: what the
 * workspace's loaders SHIP. React Router re-runs root + the workspace layout +
 * the page's own loader on every live event the page hears, so every byte the
 * layout carries for one page is paid again on every page and every event.
 *
 * Fixtures: the demo seed, viewed by arda (org admin, project admin, ten
 * notifications). The board fixture adds thirty clones of the demo's task
 * files (40 tasks). Every figure is taken on the second (warm) revalidation;
 * bytes are the JSON of each loader's result, summed.
 */

let app: AppTestContext;
let ardaId: string;
let cookie: string;
const SLUG = "viberr-core";

beforeAll(async () => {
  pinPerfClock();
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  ({ cookie } = await app.cookieFor(ardaId));
});
afterAll(() => {
  vi.useRealTimers();
  app.cleanup();
});

/** One Request's loader arguments: single fetch hands every loader of a
 *  request the same ones. */
function argsFor<P extends Record<string, string>>(url: string, params: P) {
  return routeArgs(app.request(url, { cookie }), params, url);
}

/** Rows the bell's list query returned (`listNotifications`). */
const NOTIFICATION_LIST = /SELECT n\.\*, p\.name AS project_name/;

async function layoutModules() {
  const [root, layout] = await Promise.all([import("~/root"), import("~/routes/project")]);
  return { root, layout };
}

function bytesOf<T>(value: T): number {
  return Buffer.byteLength(JSON.stringify(value));
}

describe("workspace payloads (ruling 457)", () => {
  it("FL-4 / SRV-6 / BOARD-6: a task page's layout carries no board and no bell list", async () => {
    const { root, layout } = await layoutModules();
    const task = await import("~/routes/project.task");
    const run = () => {
      const args = argsFor(`/projects/${SLUG}/tasks/VIB-142.data`, { slug: SLUG, key: "VIB-142" });
      return Promise.all([root.loader(args), layout.loader(args), task.loader(args)]);
    };
    await run();
    const { result, tally } = await tallyServerReads(app.dataRoot, run);
    const shell = result[1];
    // Everything the shell and the task page read is still there.
    expect(shell).toMatchObject({ myRole: "admin", unread: 6, orphanUnread: 0 });
    expect(shell).not.toHaveProperty("notifications");
    expectWithinBudget("payload:task-page.layout-bytes", bytesOf(shell));
    expectWithinBudget(
      "payload:task-page.notification-rows",
      rowsMatching(tally, NOTIFICATION_LIST),
    );
  });

  it("BOARD-6: a settings revalidation ships and reads only what settings shows", async () => {
    const { root, layout } = await layoutModules();
    const settings = await import("~/routes/project.settings");
    const run = () => {
      const args = argsFor(`/projects/${SLUG}/settings.data`, { slug: SLUG });
      return Promise.all([root.loader(args), layout.loader(args), settings.loader(args)]);
    };
    await run();
    const { result, tally } = await tallyServerReads(app.dataRoot, run);
    expect(result[2]).toHaveProperty("view");
    expectWithinBudget("payload:settings-revalidation.bytes", result.reduce((n, r) => n + bytesOf(r), 0));
    expectWithinBudget("payload:settings-revalidation.sql", tally.statements.length);
  });
});

describe("board payload on 40 tasks (ruling 457)", () => {
  beforeAll(async () => {
    // Thirty clones of the demo's own task files under new keys, so the board
    // carries 40 cards with the demo's real variety of fields.
    const { parseTaskFileContent, serializeTaskFile } = await import(
      "~/server/files/task-file.server"
    );
    const { writeFileAtomic } = await import("~/server/files/atomic-file.server");
    const { taskFilePath } = await import("~/server/files/file-store-root.server");
    const tasksDir = path.join(app.dataRoot, "projects", SLUG, "tasks");
    const sources = readdirSync(tasksDir).sort();
    for (let i = 0; i < 30; i += 1) {
      const source = sources[i % sources.length]!;
      const { parsed } = parseTaskFileContent(
        readFileSync(path.join(tasksDir, source, "task.md"), "utf8"),
      );
      const key = `VIB-${300 + i}`;
      parsed.frontmatter.key = key;
      writeFileAtomic(taskFilePath(SLUG, key, app.dataRoot), serializeTaskFile(parsed));
    }
    const { rebuildAll } = await import("~/server/projections/rebuilder.server");
    rebuildAll(app.db, { dataRoot: app.dataRoot });
  });

  it("BOARD-3 / BOARD-6: the board ships the fields its cards read", async () => {
    const { root, layout } = await layoutModules();
    const board = await import("~/routes/project.board");
    const run = () => {
      const args = argsFor(`/projects/${SLUG}/board.data`, { slug: SLUG });
      return Promise.all([root.loader(args), layout.loader(args), board.loader(args)]);
    };
    await run();
    const result = await run();
    const cards = [
      ...result[2].columns.flatMap((c) => c.tasks),
      ...result[2].orphanTasks,
    ];
    expect(cards).toHaveLength(40);
    expectWithinBudget(
      "payload:board-40.revalidation-bytes",
      result.reduce((n, r) => n + bytesOf(r), 0),
    );
    expectWithinBudget(
      "payload:board-40.card-bytes",
      cards.reduce((sum, c) => sum + bytesOf(c), 0),
    );
    expectWithinBudget(
      "payload:board-40.card-fields",
      Math.max(...cards.map((c) => Object.keys(c).length)),
    );
  });
});
