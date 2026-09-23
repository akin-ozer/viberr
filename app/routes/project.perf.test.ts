import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import {
  rowsMatching,
  statementsMatching,
  tallyServerReads,
} from "../../test-support/server-read-probe";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 454, journey `board-live` / `server`: what one board revalidation
 * costs the shared event loop. React Router re-runs root + the workspace
 * layout on every live event the board hears, both handed ONE Request.
 *
 * Fixture: the demo seed's viberr-core board, viewed by arda (org admin,
 * project admin). Measured on the SECOND revalidation (the steady state).
 */

let app: AppTestContext;
let ardaId: string;
const SLUG = "viberr-core";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

async function revalidateBoard(cookie: string) {
  const [root, layout] = await Promise.all([import("~/root"), import("~/routes/project")]);
  const request = app.request(`/projects/${SLUG}/board.data`, { cookie });
  const args = {
    request,
    url: new URL(request.url),
    params: { slug: SLUG },
    pattern: "/projects/:slug/board",
    context: new RouterContextProvider(),
  };
  return Promise.all([root.loader(args), layout.loader(args)]);
}

describe("board revalidation (ruling 454)", () => {
  it("stays within its server-read budgets", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const [, cold] = await revalidateBoard(cookie);
    const { storeFileParseCounts, resetParseMemoForTests } = await import(
      "~/server/files/parse-memo.server"
    );
    resetParseMemoForTests();
    const { result, tally } = await tallyServerReads(app.dataRoot, () => revalidateBoard(cookie));
    const parses = storeFileParseCounts();

    // Correctness first: the rail counts and the board read the same as before.
    const layout = result[1];
    expect(layout.taskCount).toBe(cold.taskCount);
    expect(layout.reviewCount).toBe(cold.reviewCount);
    expect(layout.reviewCount).toBeGreaterThan(0);

    expectWithinBudget(
      "server-read:board-revalidation.yaml-parses",
      parses["project-file"] + parses["task-file"] + parses["agent-profile"],
    );
    expectWithinBudget("server-read:board-revalidation.store-reads", tally.storeReads.length);
    expectWithinBudget("server-read:board-revalidation.sql", tally.statements.length);
    expectWithinBudget(
      "server-read:board-revalidation.session-lookups",
      statementsMatching(tally, /from "session"/i).length,
    );
    expectWithinBudget(
      "server-read:board-revalidation.task-rows",
      rowsMatching(tally, /SELECT \* FROM task_projections/),
    );
  });
});
