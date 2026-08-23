import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id; // org admin
  elifId = findUserByEmail(app.db, "elif@viberr.dev")!.id; // not admin
});
afterAll(() => app.cleanup());

async function loadInsights(userId: string) {
  const { loader } = await import("~/routes/insights");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request("/insights", { cookie });
  return loader({
    request,
    url: new URL(request.url),
    pattern: "/insights",
    params: {},
    context: new RouterContextProvider(),
  });
}

describe("/insights loader", () => {
  it("returns an aggregate summary for an admin", async () => {
    const result = await loadInsights(ardaId);
    expect(result.summary).toBeDefined();
    expect(result.summary.totals.runs).toBeGreaterThanOrEqual(0);
    expect(result.summary.windowDays).toBe(30);
    expect(result.summary.daily).toHaveLength(30);
  });

  it("refuses a non-admin", async () => {
    await expect(loadInsights(elifId)).rejects.toBeDefined();
  });
});
