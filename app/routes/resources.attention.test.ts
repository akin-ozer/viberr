import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 481(c) (F40-51): the snapshot the attention watcher reads, the
 * viewer's own unread decisions only, uncached, and a 401 (never a login
 * redirect) for a tab whose session is gone.
 *
 * Canary: answer `attentionSnapshot` for a fixed user instead of the
 * session's, or drop the auth guard, and a case below fails.
 */

let app: AppTestContext;
let arda: string;
let deniz: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  arda = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  deniz = findUserByEmail(app.db, "deniz@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

async function load(cookie?: string): Promise<Response> {
  const { loader } = await import("~/routes/resources.attention");
  const request = app.request("/resources/attention", cookie ? { cookie } : {});
  return loader(routeArgs(request, {}, "/resources/attention"));
}

describe("/resources/attention (ruling 481)", () => {
  it("answers the viewer's own snapshot, uncached", async () => {
    const { attentionSnapshot, createNotification } = await import(
      "~/server/projections/notifications.server"
    );
    createNotification(app.db, {
      userId: deniz,
      kind: "question",
      title: "Developer asks: which schema?",
      text: "Two schemas fit.",
      bypassPrefs: true,
    });
    const response = await load((await app.cookieFor(deniz)).cookie);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body: unknown = await response.json();
    expect(body).toEqual(attentionSnapshot(app.db, deniz));
    expect(body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ title: "Developer asks: which schema?" }),
      ]),
    });
    const theirs: unknown = await (await load((await app.cookieFor(arda)).cookie)).json();
    expect(theirs).toEqual(attentionSnapshot(app.db, arda));
    expect(theirs).not.toEqual(body);
  });

  it("answers a signed-out request 401, never a login redirect", async () => {
    const answer = load();
    await expect(answer).rejects.not.toBeInstanceOf(Response);
    await expect(answer).rejects.toMatchObject({ init: { status: 401 } });
  });
});
