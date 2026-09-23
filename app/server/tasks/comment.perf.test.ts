import { afterAll, beforeAll, describe, it } from "vitest";
import type { TaskActor } from "./task-mutation.server";
import { countFileReads, countSql } from "../../../test-support/perf-counters";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";

/**
 * Ruling 454: what one comment costs the shared server (findings CS-4, CS-5),
 * measured on `commentToAgent` — the function the task page's comment action
 * calls — on the demo seed's VIB-142. Authentication is the route's and is not
 * counted here.
 */

let app: AppTestContext;
let actor: TaskActor;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  const arda = findUserByEmail(app.db, "arda@viberr.dev")!;
  actor = { userId: arda.id, label: arda.email };
});
afterAll(() => app.cleanup());

describe("comment write cost (ruling 454)", () => {
  it("CS-5: a comment with no @ skips the mention machinery", async () => {
    const { commentToAgent } = await import("./task-actions.server");
    const sql = countSql(app.db);
    const reads = countFileReads(app.dataRoot);
    await commentToAgent(
      app.db,
      { projectSlug: "viberr-core", taskKey: "VIB-142", text: "Looks good to me, merging after CI." },
      actor,
    );
    const files = reads.stop();
    const statements = sql.stop().statements;
    expectWithinBudget("writes:comment.sql", statements);
    expectWithinBudget("writes:comment.file-reads", files.length);
  });

  it("CS-4: a comment that @mentions a member leaves the watcher nothing to re-project", async () => {
    const { commentToAgent } = await import("./task-actions.server");
    const { rebuildPath } = await import("~/server/projections/rebuilder.server");
    const { taskFilePath } = await import("~/server/files/file-store-root.server");
    await commentToAgent(
      app.db,
      {
        projectSlug: "viberr-core",
        taskKey: "VIB-142",
        text: "@elif can you take a look at the schema?",
      },
      actor,
    );
    // What the file watcher does ~250 ms later: re-project the file if the
    // projection does not already match it (a second task.updated to every open
    // board and task page, and a second remount of the timeline).
    const late = rebuildPath(app.db, taskFilePath("viberr-core", "VIB-142", app.dataRoot), {
      dataRoot: app.dataRoot,
    });
    expectWithinBudget(
      "writes:mention-comment.late-reprojections",
      late.action === "projected" ? 1 : 0,
    );
  });
});
