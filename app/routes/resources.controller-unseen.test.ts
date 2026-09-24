import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * O39-d: the dock's button asks this route, on every page, whether the viewer
 * has a controller reply they have not opened. It answers the viewer's own
 * threads only, each with the page that opens it, and never a thread in a
 * project the viewer can no longer open.
 */

let app: AppTestContext;
let arda: string; // org admin, member of viberr-core
let deniz: string; // org member, member of nothing
const SLUG = "viberr-core";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  arda = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  deniz = findUserByEmail(app.db, "deniz@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

async function unseenFor(userId: string) {
  const { loader } = await import("~/routes/resources.controller-unseen");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request("/resources/controller-unseen", { cookie });
  return (
    await loader({
      request,
      url: new URL(request.url),
      params: {},
      pattern: "/resources/controller-unseen",
      context: new RouterContextProvider(),
    })
  ).unseen;
}

async function replied(userId: string, projectSlug: string | null) {
  const { createConversation, appendMessage } = await import("~/server/controller/controller-conversations.server");
  const c = createConversation(app.db, { userId, userLabel: "x", projectSlug });
  appendMessage(app.db, { conversationId: c.id, author: "user", userId, text: "Where are we?" });
  appendMessage(app.db, { conversationId: c.id, author: "controller", text: "Here." });
  return c;
}

describe("/resources/controller-unseen (O39-d)", () => {
  it("lists the viewer's unseen replies with the page that opens each", async () => {
    const instance = await replied(arda, null);
    const board = await replied(arda, SLUG);
    const unseen = await unseenFor(arda);
    // CANARY: drop the `href` mapping and the dock has nowhere to send them.
    expect(unseen.find((u) => u.id === instance.id)?.href).toBe(`/controller?c=${instance.id}`);
    expect(unseen.find((u) => u.id === board.id)?.href).toBe(`/projects/${SLUG}/controller?c=${board.id}`);
    // Another person's replies are not in it.
    const theirs = await replied(deniz, null);
    expect((await unseenFor(arda)).map((u) => u.id)).not.toContain(theirs.id);
  });

  it("leaves out a thread in a project the viewer can no longer open", async () => {
    // Deniz is a member of nothing, so a thread on viberr-core would link to
    // a page that refuses her.
    const stranded = await replied(deniz, SLUG);
    const mine = await replied(deniz, null);
    // CANARY: drop the `reachable` filter and the link leads to a refusal.
    const ids = (await unseenFor(deniz)).map((u) => u.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(stranded.id);
  });

  it("rides no page revalidation, and neither does the dock's view (ruling 457)", async () => {
    // CTL-3 / RF-8. CANARY: drop `shouldRevalidate` from either route and
    // React Router reloads it on every navigation, action and revalidation of
    // every page; the view with the last `seen=1` it was loaded with.
    const status = await import("~/routes/resources.controller-unseen");
    const view = await import("~/routes/resources.controller");
    expect(status.shouldRevalidate()).toBe(false);
    expect(view.shouldRevalidate()).toBe(false);
  });

  it("is refused without a session", async () => {
    const { loader } = await import("~/routes/resources.controller-unseen");
    const request = app.request("/resources/controller-unseen");
    await expect(
      loader({
        request,
        url: new URL(request.url),
        params: {},
        pattern: "/resources/controller-unseen",
        context: new RouterContextProvider(),
      }),
    ).rejects.toBeDefined();
  });
});
