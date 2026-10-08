import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 457 (owner, 2026-09-24; FL-4 / SRV-6): the bell's list is its own
 * resource. It answers the viewer's own rows, newest first, capped where the
 * popover discloses the cap. That a page revalidation never reloads it is
 * counted where the bell mounts the route (`top-bell.test.tsx`).
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
  return loader(routeArgs(request, {}, "/resources/notifications"));
}

describe("/resources/notifications (ruling 457)", () => {
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

  // Review finding bell-hover-login-returnto-resource: the bell loads this on
  // hover, and a login redirect from here named THIS route as the returnTo, so
  // a stale tab's hover sent the person to /login and, once signed in, to a
  // page of raw JSON. A signed-out bell gets a 401 its own failure row shows;
  // the page's next real navigation asks for the sign-in, with its own path.
  it("answers a signed-out request 401, never a login redirect that names itself", async () => {
    const answer = load();
    await expect(answer).rejects.not.toBeInstanceOf(Response);
    await expect(answer).rejects.toMatchObject({ init: { status: 401 } });
  });

  it("answers 401 while a forced password reset is pending", async () => {
    const { cookie } = await app.cookieFor(deniz);
    app.db.prepare(`UPDATE users SET pwreset_required = 1 WHERE id = ?`).run(deniz);
    try {
      await expect(load(cookie)).rejects.toMatchObject({ init: { status: 401 } });
    } finally {
      app.db.prepare(`UPDATE users SET pwreset_required = 0 WHERE id = ?`).run(deniz);
    }
  });
});
