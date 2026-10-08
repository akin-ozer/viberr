import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  routeArgs,
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";

/**
 * The /insights loader is org-admin gated and returns the aggregate summary.
 * The aggregation itself is covered in insights-query.server.test.ts.
 */

let app: AppTestContext;
let ardaId: string;
let elifId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda; // org admin
  elifId = userIds.elif; // not admin
});
afterAll(() => app.cleanup());

async function loadInsights(userId: string) {
  const { loader } = await import("~/routes/insights");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request("/insights", { cookie });
  return loader(routeArgs(request, {}, "/insights"));
}

describe("/insights loader", () => {
  it("returns an aggregate summary for an admin", async () => {
    const result = await loadInsights(ardaId);
    // The demo seed has no run history: every backend is named, none is read.
    expect(result.summary.backends).toEqual([
      { backend: "claude", runs: 0 },
      { backend: "codex", runs: 0 },
    ]);
    expect(result.summary.runs).toEqual([]);
    expect(result.summary.oversight.clarity.activeTasks).toBeGreaterThan(0);
  });

  it("refuses a non-admin", async () => {
    await expect(loadInsights(elifId)).rejects.toMatchObject({ status: 403 });
  });
});
