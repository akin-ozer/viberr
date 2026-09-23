import { afterEach, describe, expect, it } from "vitest";
import type { UserRole } from "~/shared/mapping/user.server";
import {
  statementsMatching,
  tallyServerReads,
  type ServerReadTally,
} from "../../../test-support/server-read-probe";
import { setupAppTest } from "../../../test-support/test-app";
import { authenticate, requireAuth, roleSatisfies } from "./require-user.server";
import { insertUser } from "./user-store.server";

describe("roleSatisfies (RBAC matrix)", () => {
  const matrix: Array<[UserRole, UserRole, boolean]> = [
    ["admin", "admin", true],
    ["admin", "member", true],
    ["member", "admin", false],
    ["member", "member", true],
  ];
  for (const [role, required, expected] of matrix) {
    it(`${role} ${expected ? "satisfies" : "does not satisfy"} ${required}`, () => {
      expect(roleSatisfies(role, required)).toBe(expected);
    });
  }
});

/**
 * authenticate() resolves a better-auth session into the app's AuthContext,
 * bridged to the canonical `users` row. Exercised against real better-auth
 * cookies minted by the app harness.
 */
describe("authenticate (better-auth session)", () => {
  let app: Awaited<ReturnType<typeof setupAppTest>>;
  afterEach(() => app?.cleanup());

  async function seedUser(role: UserRole = "member") {
    app = await setupAppTest();
    const user = insertUser(app.db, {
      id: "u_auth",
      email: "auth@viberr.test",
      name: "Auth User",
      title: "QA",
      role,
    });
    const { cookie, sessionId } = await app.cookieFor(user.id);
    return { user, cookie, sessionId };
  }

  it("resolves the SessionUser for a valid session cookie", async () => {
    const { user, cookie, sessionId } = await seedUser();
    const auth = await authenticate(app.request("/some/where", { cookie }));
    expect(auth).not.toBeNull();
    expect(auth!.user).toEqual({
      id: user.id,
      email: "auth@viberr.test",
      name: "Auth User",
      title: "QA",
      role: "member",
      theme: "system",
      idp: "local",
      avatarTone: "",
    });
    expect(auth!.pwresetRequired).toBe(false);
    expect(auth!.sessionId).toBe(sessionId);
  });

  it("returns null without a cookie or with a garbage cookie", async () => {
    await seedUser();
    expect(await authenticate(app.request("/x"))).toBeNull();
    expect(
      await authenticate(
        app.request("/x", { cookie: "viberr.session_token=not-a-real-token" }),
      ),
    ).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const { user, cookie } = await seedUser();
    app.db
      .prepare(`UPDATE session SET expiresAt = ? WHERE userId = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), user.id);
    expect(await authenticate(app.request("/x", { cookie }))).toBeNull();
  });

  it("returns null and revokes the session when the user is disabled", async () => {
    const { user, cookie } = await seedUser();
    app.db.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).run(user.id);
    expect(await authenticate(app.request("/x", { cookie }))).toBeNull();
    // SAFETY: `count(*)` is an aggregate with no GROUP BY — sqlite answers it
    // with exactly one row carrying the single integer column `c`.
    const count = app.db
      .prepare(`SELECT count(*) AS c FROM session WHERE userId = ?`)
      .get(user.id) as { c: number };
    expect(count.c).toBe(0);
  });

  it("surfaces the pwreset_required gate", async () => {
    app = await setupAppTest();
    const user = insertUser(app.db, {
      id: "u_reset",
      email: "reset@viberr.test",
      name: "Reset Me",
      role: "member",
      pwresetRequired: true,
    });
    const { cookie } = await app.cookieFor(user.id);
    const auth = await authenticate(app.request("/x", { cookie }));
    expect(auth?.pwresetRequired).toBe(true);
  });
});

/**
 * Ruling 454 (FL-8 / SRV-7): React Router hands every loader of one request
 * the same Request, so the session is resolved once per Request — for reads.
 */
describe("one session resolution per Request (ruling 454)", () => {
  let app: Awaited<ReturnType<typeof setupAppTest>>;
  afterEach(() => app?.cleanup());

  async function signedIn() {
    app = await setupAppTest();
    const user = insertUser(app.db, {
      id: "u_memo",
      email: "memo@viberr.test",
      name: "Memo User",
      role: "member",
    });
    return { user, ...(await app.cookieFor(user.id)) };
  }

  const sessionReads = (tally: ServerReadTally) => statementsMatching(tally, /from "session"/i).length;

  it("every guard on one GET shares a single resolution", async () => {
    const { user, cookie } = await signedIn();
    const request = app.request("/projects/acme/board.data", { cookie });
    const { result, tally } = await tallyServerReads(app.dataRoot, async () => [
      await authenticate(request),
      await requireAuth(request),
      await authenticate(request),
    ]);
    expect(result.map((r) => r?.user.id)).toEqual([user.id, user.id, user.id]);
    expect(sessionReads(tally)).toBe(1);
  });

  it("a new Request resolves again, so a revoked session is seen at once", async () => {
    const { user, cookie } = await signedIn();
    expect(await authenticate(app.request("/x", { cookie }))).not.toBeNull();
    app.db.prepare(`DELETE FROM session WHERE userId = ?`).run(user.id);
    expect(await authenticate(app.request("/x", { cookie }))).toBeNull();
  });

  it("a POST resolves on every call: an action can change its own session", async () => {
    const { user, cookie } = await signedIn();
    const request = app.request("/logout", { method: "POST", cookie });
    expect(await authenticate(request)).not.toBeNull();
    app.db.prepare(`DELETE FROM session WHERE userId = ?`).run(user.id);
    // CANARY: memoize mutations too and this still answers the deleted session.
    expect(await authenticate(request)).toBeNull();
  });
});

/**
 * React Router 8 hands loaders the RAW request, so on single-fetch client
 * navigations requireAuth sees the ".data" wire URL, not the app path. The
 * login redirect must normalize it (mirroring the framework's
 * getNormalizedPath) or a re-authenticated user is sent to "/x.data?...".
 */
describe("requireAuth login redirect (returnTo normalization)", () => {
  let app: Awaited<ReturnType<typeof setupAppTest>>;
  afterEach(() => app?.cleanup());

  async function redirectLocationFor(path: string): Promise<string> {
    app = await setupAppTest();
    try {
      await requireAuth(app.request(path));
    } catch (thrown) {
      if (thrown instanceof Response) {
        return thrown.headers.get("Location") ?? "";
      }
      throw thrown;
    }
    throw new Error("requireAuth did not throw for an unauthenticated request");
  }

  it("strips the .data suffix and _routes param from single-fetch URLs", async () => {
    const location = await redirectLocationFor(
      "/projects/acme/board.data?_routes=routes%2Fproject.board",
    );
    expect(location).toBe(
      `/login?returnTo=${encodeURIComponent("/projects/acme/board")}`,
    );
  });

  it("keeps real search params while stripping the wire format", async () => {
    const location = await redirectLocationFor(
      "/projects/acme/board.data?view=list&_routes=routes%2Fproject.board",
    );
    expect(location).toBe(
      `/login?returnTo=${encodeURIComponent("/projects/acme/board?view=list")}`,
    );
  });

  it("treats the root single-fetch URL like the root document request", async () => {
    expect(await redirectLocationFor("/_.data")).toBe("/login");
    expect(await redirectLocationFor("/")).toBe("/login");
  });

  it("preserves document-request URLs untouched", async () => {
    const location = await redirectLocationFor("/projects/acme/board?view=list");
    expect(location).toBe(
      `/login?returnTo=${encodeURIComponent("/projects/acme/board?view=list")}`,
    );
  });
});
