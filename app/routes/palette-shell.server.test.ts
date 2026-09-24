import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";

/**
 * Ruling 145 — the standalone-page layout's loader.
 *
 * It answers one question: does THIS route take the app header, and with what.
 * The scoping is the point. `/org/settings` and `/insights` get the viewer, the
 * notification slice and the unread count the header renders; `/controller`,
 * `/profile` and `/notifications` get nothing at all — not even an auth call —
 * so the routes that render no header cost exactly what they cost before the
 * header existed, and their own guards stay the only ones that speak.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

async function loadShell(path: string, userId?: string) {
  const { loader } = await import("~/routes/palette-shell");
  const cookie = userId ? (await app.cookieFor(userId)).cookie : undefined;
  const request = app.request(path, cookie ? { cookie } : {});
  return loader({
    request,
    url: new URL(request.url),
    pattern: "/",
    params: {},
    context: new RouterContextProvider(),
  });
}

describe("palette-shell loader (ruling 145)", () => {
  it("hands the header the viewer and their bell's counts on a page route", async () => {
    const result = await loadShell("/org/settings", ardaId);
    expect(result.header).not.toBeNull();
    expect(result.header!.user.id).toBe(ardaId);
    expect(result.header!.user.name).toBeTruthy();
    expect(result.header!.unread).toBeGreaterThanOrEqual(0);
    expect(result.header!.orphanUnread).toBe(0);
    // Ruling 454 (owner, 2026-09-24): the bell loads its own list.
    expect(result.header).not.toHaveProperty("notifications");
  });

  it("answers the same on the other page route", async () => {
    const result = await loadShell("/insights", ardaId);
    expect(result.header?.user.id).toBe(ardaId);
  });

  it("reads the tab and the query string as the same page", async () => {
    // Canary: match on the whole URL and every tab link stops carrying a
    // header — the surface it names has not changed.
    const result = await loadShell("/org/settings?tab=users&all=1", ardaId);
    expect(result.header?.user.id).toBe(ardaId);
  });

  it("answers a REVALIDATION the same as the page load it belongs to", async () => {
    // Every revalidation is a single-fetch data request — the URL React Router
    // asks for is `/org/settings.data?tab=resources`, and a loader that reads
    // that pathname literally finds no page by that name. It answered "no
    // header" one submit after the page loaded, and the header vanished off a
    // page that was still open. Found live: the org-settings file browser
    // closed itself the moment a folder was created inside it.
    const result = await loadShell("/org/settings.data?tab=resources", ardaId);
    expect(result.header?.user.id).toBe(ardaId);
    expect((await loadShell("/insights.data", ardaId)).header).not.toBeNull();
    // The routes with no header stay that way through their own revalidations.
    expect((await loadShell("/profile.data", ardaId)).header).toBeNull();
  });

  it("carries no header — and reads nothing — on the routes that render none", async () => {
    for (const path of ["/controller", "/profile", "/notifications"]) {
      expect((await loadShell(path, ardaId)).header, path).toBeNull();
    }
  });

  it("does not become a second auth guard on those routes", async () => {
    // Signed OUT. The child route is what refuses (and the refusal shape is
    // its own test's business); a layout that asked for a user here would move
    // that decision, and with it the redirect, up one level.
    expect((await loadShell("/profile")).header).toBeNull();
  });

  it("still refuses an anonymous viewer on a page route", async () => {
    await expect(loadShell("/org/settings")).rejects.toBeDefined();
  });
});
