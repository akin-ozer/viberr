import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import { z } from "zod";
import type { SeedUserIds } from "../../test-support/demo-data";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 548: the Blocked by picker's read, as real requests against the
 * route: a 401 rather than a login redirect because a fetcher loads it, the
 * task page's membership gate, and the list for a member. Which tasks are
 * barred and why is `server/projections/dependencies.server.test.ts`.
 */

let app: AppTestContext;
let ids: SeedUserIds;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
});
afterAll(() => app.cleanup());

/** What a loader throws: React Router's `data()` envelope. */
const thrownEnvelope = z.object({ init: z.object({ status: z.number() }) });

async function readCandidates(key: string, userId: string | null) {
  const { loader } = await import("~/routes/task-dependency-candidates");
  const cookie = userId ? (await app.cookieFor(userId)).cookie : undefined;
  const request = app.request(
    `/projects/viberr-core/tasks/${key}/dependency-candidates`,
    cookie ? { cookie } : {},
  );
  return loader({
    request,
    url: new URL(request.url),
    params: { slug: "viberr-core", key },
    pattern: "/projects/:slug/tasks/:key/dependency-candidates",
    context: new RouterContextProvider(),
  });
}

async function refusedStatus(read: Promise<unknown>): Promise<number | null> {
  try {
    await read;
    return null;
  } catch (error) {
    return thrownEnvelope.parse(error).init.status;
  }
}

describe("ruling 548: the Blocked by picker's read", () => {
  it("answers a signed-out fetch 401, and a non-member or an unknown task the page's 404", async () => {
    // CANARY: gate on `requireUser` and the signed-out fetch is redirected to
    // /login, which a fetcher follows as a navigation away from the task.
    expect(await refusedStatus(readCandidates("VIB-142", null))).toBe(401);
    expect(await refusedStatus(readCandidates("VIB-142", ids.deniz))).toBe(404);
    expect(await refusedStatus(readCandidates("VIB-999", ids.selin))).toBe(404);
  });

  it("gives a member the project's other tasks, each with its title and stage", async () => {
    const view = await readCandidates("VIB-142", ids.selin);
    if (!view.ok) throw new Error(view.reason);
    expect(view.tasks.map((t) => t.key)).not.toContain("VIB-142");
    expect(view.tasks.find((t) => t.key === "VIB-148")).toEqual({
      key: "VIB-148",
      title: "Validate PAT scope before GitHub sync",
      stage: "Ready",
      bar: null,
    });
  });
});
