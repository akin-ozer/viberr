import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 454 (owner, 2026-09-24; FL-4 / SRV-6): the bell's list is its own
 * resource. It answers the viewer's own rows, newest first, capped where the
 * popover discloses the cap; a page revalidation never reloads it.
 */

let app: AppTestContext;
let arda: string; // ten seeded notifications
let deniz: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  arda = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  deniz = findUserByEmail(app.db, "deniz@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

async function load(cookie?: string) {
  const { loader } = await import("~/routes/resources.notifications");
  const request = app.request("/resources/notifications", cookie ? { cookie } : {});
  return loader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: "/resources/notifications",
    context: new RouterContextProvider(),
  });
}

describe("/resources/notifications (ruling 454)", () => {
  it("lists the viewer's own rows, newest first, as the popover draws them", async () => {
    const { listNotifications } = await import("~/server/projections/notifications.server");
    const { notifications } = await load((await app.cookieFor(arda)).cookie);
    expect(notifications).toHaveLength(10);
    expect(notifications).toEqual(listNotifications(app.db, arda, { limit: 100 }));
    const { notifications: theirs } = await load((await app.cookieFor(deniz)).cookie);
    expect(theirs.map((n) => n.id)).not.toEqual(
      expect.arrayContaining(notifications.map((n) => n.id)),
    );
  });

  it("stops at the bell's cap", async () => {
    const { createNotification } = await import("~/server/projections/notifications.server");
    const { BELL_LIST_CAP } = await import("~/features/shell/top-bell");
    for (let i = 0; i <= BELL_LIST_CAP; i += 1) {
      createNotification(app.db, { userId: deniz, kind: "mention", text: `n${i}`, bypassPrefs: true });
    }
    const { notifications } = await load((await app.cookieFor(deniz)).cookie);
    expect(notifications).toHaveLength(BELL_LIST_CAP);
  });

  it("asks a signed-out request to sign in", async () => {
    await expect(load()).rejects.toMatchObject({ status: 302 });
  });

  it("is never reloaded by a page's revalidation", async () => {
    const { shouldRevalidate } = await import("~/routes/resources.notifications");
    expect(shouldRevalidate()).toBe(false);
  });
});
