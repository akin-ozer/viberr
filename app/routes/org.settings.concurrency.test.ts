import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";
import { getMaxConcurrentRuns } from "~/server/settings/instance-settings.server";

/**
 * The org-settings `set-concurrency` intent persists the instance run
 * concurrency cap. The action is uniformly org-admin gated (requireRoleAuth);
 * this pins the happy path + the input validation.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda; // org admin
});
afterAll(() => app.cleanup());

async function setCap(
  userId: string,
  value: string,
): Promise<{ status: number; body: { ok: boolean; toast?: string; error?: string } }> {
  const { action } = await import("~/routes/org.settings");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const fd = new FormData();
  fd.set("intent", "set-concurrency");
  fd.set("maxConcurrentRuns", value);
  fd.set("_csrf", csrf);
  const request = app.request("/org/settings", {
    method: "POST",
    body: fd,
    cookie,
  });
  try {
    const result = await action({
      request,
      url: new URL(request.url),
      pattern: "/org/settings",
      params: {},
      context: new RouterContextProvider(),
    });
    const body = "data" in result ? result.data : result;
    const status = "init" in result ? (result.init?.status ?? 200) : 200;
    return { status, body };
  } catch (thrown) {
    // requireRoleAuth throws a Response for a non-admin.
    if (thrown instanceof Response) {
      return { status: thrown.status, body: { ok: false } };
    }
    throw thrown;
  }
}

describe("org-settings set-concurrency", () => {
  it("an org admin sets the cap and it persists", async () => {
    const { body } = await setCap(ardaId, "3");
    expect(body.ok).toBe(true);
    expect(body.toast).toMatch(/capped at 3/);
    expect(getMaxConcurrentRuns(app.db)).toBe(3);
  });

  it("0 lifts the cap back to unlimited", async () => {
    await setCap(ardaId, "5");
    const { body } = await setCap(ardaId, "0");
    expect(body.ok).toBe(true);
    expect(body.toast).toMatch(/unlimited/);
    expect(getMaxConcurrentRuns(app.db)).toBe(0);
  });

  it("rejects a negative / non-numeric value without changing the cap", async () => {
    await setCap(ardaId, "4");
    const bad = await setCap(ardaId, "-1");
    expect(bad.body.ok).toBe(false);
    expect(getMaxConcurrentRuns(app.db)).toBe(4);
  });
});
