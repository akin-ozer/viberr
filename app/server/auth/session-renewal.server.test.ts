import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";

/**
 * F10-17 — rolling-session renewal must reach the BROWSER.
 *
 * auth.server.ts configures a 30-day expiry with a 1-day updateAge. When a
 * session is touched past that updateAge better-auth slides the DB expiry AND
 * emits a fresh session cookie. The old code called `getSession({ headers })`
 * and read only the session object, silently dropping that `Set-Cookie` — so
 * the DB thought the session was renewed while the browser's cookie still
 * expired at login+30d. An active user would be logged out mid-work.
 *
 * The fix is two halves, and BOTH are load-bearing, so both are pinned here:
 * `authenticateWithHeaders` captures the header (returnHeaders: true), and the
 * root loader forwards it onto the response.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

/**
 * Age a session by `daysAgo`. better-auth decides a roll is due from how much
 * of `expiresIn` is left (refresh once `expiresAt - now < expiresIn -
 * updateAge`), so the remaining lifetime is what has to move — `updatedAt` is
 * carried along only to keep the row self-consistent.
 */
function ageSession(sessionId: string, daysAgo: number): void {
  const day = 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + (30 - daysAgo) * day);
  const updatedAt = new Date(Date.now() - daysAgo * day);
  app.db
    .prepare(`UPDATE "session" SET "expiresAt" = ?, "updatedAt" = ? WHERE id = ?`)
    .run(expiresAt.toISOString(), updatedAt.toISOString(), sessionId);
}

async function rootLoader(cookie: string) {
  const { loader } = await import("~/root");
  return loader({
    request: app.request("/", { cookie }),
    params: {},
    context: {},
  } as never);
}

describe("F10-17: rolling-session renewal reaches the browser", () => {
  it("authenticateWithHeaders returns the identity AND a Headers bag", async () => {
    const { authenticateWithHeaders } = await import(
      "~/server/auth/require-user.server"
    );
    const { cookie } = await app.cookieFor(ardaId);
    const { ctx, renewalHeaders } = await authenticateWithHeaders(
      app.request("/", { cookie }),
    );

    expect(ctx?.user.id).toBe(ardaId);
    // Always a Headers — callers can ask for getSetCookie() unconditionally.
    expect(renewalHeaders).toBeInstanceOf(Headers);
  });

  it("a session past the updateAge emits a renewal Set-Cookie", async () => {
    const { authenticateWithHeaders } = await import(
      "~/server/auth/require-user.server"
    );
    const { cookie, sessionId } = await app.cookieFor(ardaId);
    ageSession(sessionId, 3);

    const { ctx, renewalHeaders } = await authenticateWithHeaders(
      app.request("/", { cookie }),
    );

    expect(ctx?.user.id).toBe(ardaId);
    const setCookies = renewalHeaders.getSetCookie();
    expect(setCookies.length).toBeGreaterThan(0);
    expect(setCookies.join("\n")).toContain("session_token");
  });

  it("the root loader FORWARDS that renewal cookie onto the response", async () => {
    const { cookie, sessionId } = await app.cookieFor(ardaId);
    ageSession(sessionId, 3);

    const result = (await rootLoader(cookie)) as {
      init?: { headers?: Headers };
      data?: { theme?: string };
    };

    // A renewal is due, so the loader must return data() WITH headers rather
    // than a bare payload — otherwise the slide never reaches the browser.
    const headers = result.init?.headers;
    expect(headers).toBeDefined();
    const forwarded = new Headers(headers).getSetCookie();
    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded.join("\n")).toContain("session_token");
    // The payload itself is still present (P11-46 removed the unread `user`
    // field; theme remains).
    expect(result.data?.theme).toBeDefined();
  });

  it("a fresh session adds no headers (the common path stays a bare payload)", async () => {
    const { cookie, sessionId } = await app.cookieFor(ardaId);
    // Well inside the updateAge window — no roll is due.
    ageSession(sessionId, 0);

    const result = (await rootLoader(cookie)) as {
      init?: unknown;
      theme?: string;
    };

    // Bare payload: no data() wrapper, so no stray Set-Cookie is written.
    expect(result.init).toBeUndefined();
    expect(result.theme).toBeDefined();
  });

  it("the headers export surfaces loader headers for routes without their own", async () => {
    const { headers } = await import("~/root");
    const loaderHeaders = new Headers();
    loaderHeaders.append("Set-Cookie", "session_token=abc; Path=/");
    expect(headers({ loaderHeaders } as never)).toBe(loaderHeaders);
  });
});
