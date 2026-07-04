import { afterEach, describe, expect, it } from "vitest";
import type { UserRole } from "~/shared/mapping/user.server";
import { createTestDbContext } from "../../../test-support/test-db";
import { authenticateRequest, roleSatisfies } from "./require-user.server";
import { signSessionValue, SESSION_COOKIE_NAME } from "./session-cookie.server";
import {
  createSession,
  SESSION_RENEW_INTERVAL_MS,
  SESSION_TTL_MS,
} from "./session.server";
import { insertUser } from "./user-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const SECRET = "require-user-secret-require-user-secret";

function requestWithSession(token: string): Request {
  return new Request("http://localhost:5173/some/where", {
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${signSessionValue(token, SECRET)}`,
    },
  });
}

describe("roleSatisfies (RBAC matrix)", () => {
  const matrix: Array<[UserRole, UserRole, boolean]> = [
    ["admin", "admin", true],
    ["admin", "member", true],
    ["admin", "viewer", true],
    ["member", "admin", false],
    ["member", "member", true],
    ["member", "viewer", true],
    ["viewer", "admin", false],
    ["viewer", "member", false],
    ["viewer", "viewer", true],
  ];
  for (const [role, required, expected] of matrix) {
    it(`${role} ${expected ? "satisfies" : "does not satisfy"} ${required}`, () => {
      expect(roleSatisfies(role, required)).toBe(expected);
    });
  }
});

describe("authenticateRequest", () => {
  function seed(db: ReturnType<typeof ctx.makeDb>) {
    const user = insertUser(db, {
      id: "u_auth",
      email: "auth@viberr.test",
      name: "Auth User",
      title: "QA",
      role: "member",
    });
    const session = createSession(db, user.id);
    return { user, session };
  }

  it("resolves the SessionUser for a valid signed cookie", () => {
    const db = ctx.makeDb();
    const { user, session } = seed(db);
    const auth = authenticateRequest(db, requestWithSession(session.token), SECRET);
    expect(auth).not.toBeNull();
    expect(auth!.user).toEqual({
      id: user.id,
      email: "auth@viberr.test",
      name: "Auth User",
      title: "QA",
      role: "member",
      theme: "system",
      idp: "local",
    });
    expect(auth!.pwresetRequired).toBe(false);
    expect(auth!.sessionId).toBe(session.id);
    expect(auth!.sessionToken).toBe(session.token);
  });

  it("returns null without a cookie / with a forged signature", () => {
    const db = ctx.makeDb();
    const { session } = seed(db);
    expect(
      authenticateRequest(db, new Request("http://x/"), SECRET),
    ).toBeNull();
    const forged = new Request("http://x/", {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}.forged` },
    });
    expect(authenticateRequest(db, forged, SECRET)).toBeNull();
    // Signed with a different secret.
    const wrongSecret = new Request("http://x/", {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${signSessionValue(session.token, "other-secret-other-secret-12345678")}`,
      },
    });
    expect(authenticateRequest(db, wrongSecret, SECRET)).toBeNull();
  });

  it("returns null for an expired session", () => {
    const db = ctx.makeDb();
    const { session } = seed(db);
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
      session.id,
    );
    expect(
      authenticateRequest(db, requestWithSession(session.token), SECRET),
    ).toBeNull();
  });

  it("returns null and kills the session when the user is disabled", () => {
    const db = ctx.makeDb();
    const { user, session } = seed(db);
    db.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).run(user.id);
    expect(
      authenticateRequest(db, requestWithSession(session.token), SECRET),
    ).toBeNull();
    const count = db.prepare(`SELECT count(*) AS c FROM sessions`).get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });

  it("flags sessionRenewed when the rolling expiry slides", () => {
    const db = ctx.makeDb();
    const { session } = seed(db);
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(
      new Date(
        Date.now() + SESSION_TTL_MS - SESSION_RENEW_INTERVAL_MS - 60_000,
      ).toISOString(),
      session.id,
    );
    const auth = authenticateRequest(db, requestWithSession(session.token), SECRET);
    expect(auth?.sessionRenewed).toBe(true);
  });

  it("surfaces the pwreset_required gate", () => {
    const db = ctx.makeDb();
    const user = insertUser(db, {
      id: "u_reset",
      email: "reset@viberr.test",
      name: "Reset Me",
      role: "member",
      pwresetRequired: true,
    });
    const session = createSession(db, user.id);
    const auth = authenticateRequest(db, requestWithSession(session.token), SECRET);
    expect(auth?.pwresetRequired).toBe(true);
  });
});
