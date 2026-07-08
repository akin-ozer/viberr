import { afterEach, describe, expect, it } from "vitest";
import type { UserRole } from "~/shared/mapping/user.server";
import { setupAppTest } from "../../../test-support/test-app";
import { authenticate, roleSatisfies } from "./require-user.server";
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
