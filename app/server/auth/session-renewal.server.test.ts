import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import { routeArgs, setupAppTest, type AppTestContext } from "../../../test-support/test-app";

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
 * The fix is two halves, and BOTH are load-bearing: `authenticateWithHeaders`
 * captures the header (returnHeaders: true), and root's
 * `sessionRenewalMiddleware` forwards it onto the response. Both are pinned
 * through the middleware: drop the capture and it has nothing to forward.
 * Ruling 11 moved the forwarding from the root loader to the middleware: root
 * no longer re-runs on live events and navigations (RF-7), and the day's one
 * renewal lands on whichever GET first asks once it is due, often a layout's
 * `.data` that root sits out.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
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

/**
 * Runs root's renewal middleware around `inner` the way React Router does: the
 * loaders `inner` stands for get the middleware's own Request.
 */
async function throughMiddleware(
  request: Request,
  inner: (request: Request) => Promise<object>,
): Promise<Response> {
  const { sessionRenewalMiddleware } = await import("~/server/auth/require-user.server");
  const result = await sessionRenewalMiddleware(
    routeArgs(request, {}, "/"),
    async () => {
      await inner(request);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  );
  if (!(result instanceof Response)) throw new Error("the middleware answered no Response");
  return result;
}

describe("F10-17: rolling-session renewal reaches the browser", () => {
  it("root's middleware FORWARDS a due renewal cookie onto the response", async () => {
    const { requireUser } = await import("~/server/auth/require-user.server");
    const { cookie, sessionId } = await app.cookieFor(ardaId);
    ageSession(sessionId, 3);

    const response = await throughMiddleware(app.request("/", { cookie }), requireUser);

    const forwarded = response.headers.getSetCookie();
    expect(forwarded.join("\n")).toContain("session_token");
    // The response is otherwise the one the loaders produced.
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("forwards it when root's loader sits the request out (ruling 11, RF-7)", async () => {
    // A layout `.data` without root: `_routes` names the layout alone, as a
    // live revalidation now does. The workspace loader resolves the session.
    const { loader } = await import("~/routes/project");
    const { cookie, sessionId } = await app.cookieFor(ardaId);
    ageSession(sessionId, 3);
    const request = app.request("/projects/viberr-core.data?_routes=routes%2Fproject", {
      cookie,
    });

    const response = await throughMiddleware(request, (r) =>
      loader(routeArgs(r, { slug: "viberr-core" }, "/projects/:slug")),
    );

    expect(response.headers.getSetCookie().join("\n")).toContain("session_token");
  });

  it("a fresh session adds no headers (the common path stays untouched)", async () => {
    const { requireUser } = await import("~/server/auth/require-user.server");
    const { cookie, sessionId } = await app.cookieFor(ardaId);
    // Well inside the updateAge window — no roll is due.
    ageSession(sessionId, 0);

    const response = await throughMiddleware(app.request("/", { cookie }), requireUser);

    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("a POST forwards nothing: its own action answers for the cookies it sets", async () => {
    const { requireUser } = await import("~/server/auth/require-user.server");
    const { cookie, sessionId } = await app.cookieFor(ardaId);
    ageSession(sessionId, 3);

    const response = await throughMiddleware(
      app.request("/prefs/theme", { cookie, method: "POST" }),
      requireUser,
    );

    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("the root loader still reads the session for csrf, and a document gets the live head", async () => {
    const { loader } = await import("~/root");
    const { liveHeadContext } = await import("~/server/events/sse-broker.server");
    const { cookie } = await app.cookieFor(ardaId);
    const call = (url: string) => {
      const request = app.request(url, { cookie });
      const context = new RouterContextProvider();
      context.set(liveHeadContext, 41);
      return loader({ request, url: new URL(request.url), params: {}, pattern: "/", context });
    };

    const document = await call("/");
    expect(document.csrf).toEqual(expect.any(String));
    expect(document.theme).toBe("system"); // no viberr_theme cookie: the default
    expect("liveHead" in document ? document.liveHead : undefined).toBe(41);

    // A `.data` answer seeds nothing: the tab's streams are already under way.
    const revalidation = await call("/_root.data");
    expect("liveHead" in revalidation).toBe(false);
  });
});
