import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_TEST_PASSWORD,
  routeArgs,
  setupAppTest,
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
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
});
afterAll(() => app.cleanup());

async function loginLoader(url: string, cookie?: string) {
  const { loader } = await import("~/routes/login");
  return loader(
    routeArgs(app.request(url, cookie ? { cookie } : {}), {}, "/login"),
  );
}

async function loginAction(fields: Record<string, string>, cookie?: string) {
  const { action } = await import("~/routes/login");
  const init: RequestInit & { cookie?: string } = {
    method: "POST",
    body: new URLSearchParams(fields),
  };
  // Only carry the key when there is a session cookie to attach.
  if (cookie) init.cookie = cookie;
  return action(routeArgs(app.request("/login", init), {}, "/login"));
}

/** A refusal comes back as `data(payload, init)`; a success is a redirect. */
function refused(result: Awaited<ReturnType<typeof loginAction>>) {
  if (result instanceof Response) {
    throw new Error("expected a refusal, got a redirect");
  }
  return result;
}

/** Route handlers signal redirects by THROWING a Response. */
async function caught<T>(run: () => Promise<T>): Promise<Response> {
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
    const data = await loginLoader("/login");
    expect(data.mode).toBe("login");
    expect(data.returnTo).toBeNull();
    // The harness configures no OAuth app, and the page must say so rather
    // than render two buttons that cannot work (D12).
    expect(data.providers).toEqual({ github: false, google: false });
  });

  it("keeps a safe returnTo and drops an off-site one", async () => {
    const safe = await loginLoader(
      "/login?returnTo=%2Fprojects%2Fviberr-core%2Fboard",
    );
    expect(safe.returnTo).toBe("/projects/viberr-core/board");
    const evil = await loginLoader(
      "/login?returnTo=https%3A%2F%2Fevil.example%2Fx",
    );
    expect(evil.returnTo).toBeNull();
  });

  /**
   * URL parsing REMOVES tab, newline and carriage return before resolving, so
   * "/<tab>/evil.example" is delivered to the browser as "//evil.example" — a
   * protocol-relative URL pointing off-site. A prefix check run on the raw
   * string sees a leading "/" followed by a tab and waves it through, so the
   * guard has to judge the string the browser will actually resolve.
   */
  it("drops a returnTo that only LOOKS relative until the URL parser strips it", async () => {
    for (const raw of [
      "/\t/evil.example/x",
      "/\n/evil.example/x",
      "/\r/evil.example/x",
      "/\t\\evil.example/x",
    ]) {
      const res = await loginLoader(
        `/login?returnTo=${encodeURIComponent(raw)}`,
      );
      expect(res.returnTo).toBeNull();
    }
    // A tab inside an otherwise ordinary path is still not an escape hatch:
    // whatever survives must be a single-slash local path.
    const inner = await loginLoader(
      `/login?returnTo=${encodeURIComponent("/projects/\tviberr-core/board")}`,
    );
    expect(inner.returnTo).toBe("/projects/viberr-core/board");
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
    const result = refused(await loginAction({ intent: "login", email: "" }));
    expect(result.init?.status).toBe(400);
    expect(result.data.error).toBe("Enter your email.");
    // Interface review 2026-09-06: every refusal names the field it belongs
    // to, so the page can mark, describe and focus it.
    expect(result.data.field).toBe("email");
  });

  it("a wrong password says so; an unknown email never reveals existence", async () => {
    const wrong = refused(
      await loginAction({
        intent: "login",
        email: "arda@viberr.dev",
        password: "not-the-password",
      }),
    );
    expect(wrong.init?.status).toBe(400);
    expect(wrong.data.error).toContain("Wrong password");
    expect(wrong.data.field).toBe("password");

    const unknown = refused(
      await loginAction({
        intent: "login",
        email: "nobody@viberr.dev",
        password: "whatever",
      }),
    );
    expect(unknown.init?.status).toBe(400);
    // Same copy as "account exists but has no local password" — the page must
    // not become an account-enumeration oracle.
    expect(unknown.data.error).toContain("No local account for that email");
    expect(unknown.data.field).toBe("email");

    // An OAuth-only account (a users row with no local credential) is refused
    // in the same words, on the same field. CANARY: give `no_password` its own
    // sentence in the action and the two refusals tell the accounts apart.
    const { insertTestUser } = await import("../../test-support/test-store");
    insertTestUser(app.db, "oauth-only");
    const oauthOnly = refused(
      await loginAction({
        intent: "login",
        email: "oauth-only@viberr.test",
        password: "whatever",
      }),
    );
    expect(oauthOnly.init?.status).toBe(400);
    expect(oauthOnly.data).toEqual(unknown.data);
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
    // The theme cookie rides every sign-in, so a count of Set-Cookie headers
    // says nothing about the session. CANARY: drop the loop that forwards
    // better-auth's Set-Cookie and the person lands signed out.
    expect(
      res.headers.getSetCookie().some((c) => c.includes("viberr.session_token=")),
    ).toBe(true);
  });

  it("an unknown intent is a 400, not a crash", async () => {
    const result = refused(await loginAction({ intent: "teleport" }));
    expect(result.init?.status).toBe(400);
    expect(result.data.error).toBe("Unknown action.");
    // A form-level refusal names no field.
    expect(result.data.field).toBe(null);
  });
});

describe("/logout", () => {
  it("GET redirects home — logout is a POST", async () => {
    const { loader } = await import("~/routes/logout");
    const res = await caught(async () =>
      loader(routeArgs(app.request("/logout"), {}, "/logout")),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("signed out: POST redirects to /login instead of throwing", async () => {
    const { action } = await import("~/routes/logout");
    const res = await caught(async () =>
      action(
        routeArgs(app.request("/logout", { method: "POST" }), {}, "/logout"),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("signed in: revokes the session, clears the cookie and audits the logout", async () => {
    const { cookie, sessionId } = await app.cookieFor(ardaId);
    const csrf = await app.csrfFor(sessionId);
    const { action } = await import("~/routes/logout");
    const res = await caught(async () =>
      action(
        routeArgs(
          app.request("/logout", {
            method: "POST",
            cookie,
            body: new URLSearchParams({ _csrf: csrf }),
          }),
          {},
          "/logout",
        ),
      ),
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
