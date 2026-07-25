import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  APP_TEST_PASSWORD,
  type AppTestContext,
} from "../../test-support/test-app";

/**
 * P13-UI-26 residual: `/login` and `/logout` are the only two routes in the app
 * with NO test of any kind — the surface every session starts and ends on. This
 * covers the loader's two modes, the credential action's honest failure copy,
 * the returnTo contract (`safeReturnTo` must not become an open redirect), and
 * logout's revoke-and-redirect.
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

async function loginLoader(url: string, cookie?: string) {
  const { loader } = await import("~/routes/login");
  return loader({
    request: app.request(url, cookie ? { cookie } : {}),
    params: {},
    context: {},
  } as never);
}

async function loginAction(fields: Record<string, string>, cookie?: string) {
  const { action } = await import("~/routes/login");
  return action({
    request: app.request("/login", {
      method: "POST",
      body: new URLSearchParams(fields),
      ...(cookie ? { cookie } : {}),
    }),
    params: {},
    context: {},
  } as never);
}

/** Route handlers signal redirects by THROWING a Response. */
async function caught(run: () => Promise<unknown>): Promise<Response> {
  try {
    const result = await run();
    if (result instanceof Response) return result;
    throw new Error("expected a redirect Response");
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

describe("/login loader", () => {
  it("signed-out: login mode, with per-deployment provider availability", async () => {
    const data = (await loginLoader("/login")) as {
      mode: string;
      returnTo: string | null;
      providers: { github: boolean; google: boolean };
    };
    expect(data.mode).toBe("login");
    expect(data.returnTo).toBeNull();
    // The harness configures no OAuth app, and the page must say so rather
    // than render two buttons that cannot work (D12).
    expect(data.providers).toEqual({ github: false, google: false });
  });

  it("keeps a safe returnTo and drops an off-site one", async () => {
    const safe = (await loginLoader(
      "/login?returnTo=%2Fprojects%2Fviberr-core%2Fboard",
    )) as { returnTo: string | null };
    expect(safe.returnTo).toBe("/projects/viberr-core/board");
    const evil = (await loginLoader(
      "/login?returnTo=https%3A%2F%2Fevil.example%2Fx",
    )) as { returnTo: string | null };
    expect(evil.returnTo).toBeNull();
  });

  it("an authenticated visitor is redirected away (to returnTo when given)", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const res = await caught(() =>
      loginLoader("/login?returnTo=%2Fnotifications", cookie),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/notifications");
  });
});

describe("/login action — credentials", () => {
  it("an empty email is refused before any auth call", async () => {
    const result = (await loginAction({ intent: "login", email: "" })) as {
      data: { error: string };
      init: { status: number };
    };
    expect(result.init.status).toBe(400);
    expect(result.data.error).toBe("Enter your email.");
  });

  it("a wrong password says so; an unknown email never reveals existence", async () => {
    const wrong = (await loginAction({
      intent: "login",
      email: "arda@viberr.dev",
      password: "not-the-password",
    })) as { data: { error: string }; init: { status: number } };
    expect(wrong.init.status).toBe(400);
    expect(wrong.data.error).toContain("Wrong password");

    const unknown = (await loginAction({
      intent: "login",
      email: "nobody@viberr.dev",
      password: "whatever",
    })) as { data: { error: string }; init: { status: number } };
    expect(unknown.init.status).toBe(400);
    // Same copy as "account exists but has no local password" — the page must
    // not become an account-enumeration oracle.
    expect(unknown.data.error).toContain("No local account for that email");
  });

  it("a correct password issues a session cookie and honors returnTo", async () => {
    // cookieFor provisions the harness credential for this user.
    await app.cookieFor(ardaId);
    const res = await caught(() =>
      loginAction({
        intent: "login",
        email: "arda@viberr.dev",
        password: APP_TEST_PASSWORD,
        returnTo: "/projects/viberr-core/board",
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/projects/viberr-core/board");
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it("an unknown intent is a 400, not a crash", async () => {
    const result = (await loginAction({ intent: "teleport" })) as {
      data: { error: string };
      init: { status: number };
    };
    expect(result.init.status).toBe(400);
    expect(result.data.error).toBe("Unknown action.");
  });
});

describe("/logout", () => {
  it("GET redirects home — logout is a POST", async () => {
    const { loader } = await import("~/routes/logout");
    const res = await caught(async () =>
      loader({ request: app.request("/logout"), params: {}, context: {} } as never),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("signed out: POST redirects to /login instead of throwing", async () => {
    const { action } = await import("~/routes/logout");
    const res = await caught(async () =>
      action({
        request: app.request("/logout", { method: "POST" }),
        params: {},
        context: {},
      } as never),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("signed in: revokes the session, clears the cookie and audits the logout", async () => {
    const { cookie, sessionId } = await app.cookieFor(ardaId);
    const csrf = await app.csrfFor(sessionId);
    const { action } = await import("~/routes/logout");
    const res = await caught(async () =>
      action({
        request: app.request("/logout", {
          method: "POST",
          cookie,
          body: new URLSearchParams({ _csrf: csrf }),
        }),
        params: {},
        context: {},
      } as never),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0);
    const session = app.db
      .prepare(`SELECT id FROM session WHERE id = ?`)
      .get(sessionId);
    expect(session).toBeUndefined();
    const { listAuditEvents } = await import("../../test-support/audit-log");
    expect(listAuditEvents(app.db, { action: "auth.logout" }).length).toBe(1);
  });
});
