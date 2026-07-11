import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { createAuth, type ViberrAuth } from "~/lib/auth.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  completeForcedPasswordReset,
  loginWithCredentials,
} from "./login.server";
import { provisionIdentity } from "./identity.server";
import { hashPassword, verifyPassword } from "./password.server";
import { TokenBucketLimiter } from "./rate-limit.server";
import { findUserById, insertUser } from "./user-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const PASSWORD = "correct-password";

function makeAuth(db: Database.Database): ViberrAuth {
  return createAuth({
    db,
    secret: "test-secret-at-least-32-characters-long-000",
    baseURL: "http://localhost:5173",
    trustedOrigins: ["http://localhost:5173"],
  });
}

function seedUser(
  db: Database.Database,
  overrides: Partial<Parameters<typeof insertUser>[1]> = {},
) {
  const user = insertUser(db, {
    id: "u_login",
    email: "arda@viberr.test",
    name: "Arda",
    role: "admin",
    passwordHash: hashPassword(PASSWORD),
    ...overrides,
  });
  // Mirror the real creation path: users get a better-auth identity at birth.
  provisionIdentity(db, {
    id: user.id,
    email: user.email,
    name: user.name,
    passwordHash: user.passwordHash,
    role: user.role,
  });
  return user;
}

function freshLimiter(capacity = 10) {
  return new TokenBucketLimiter({ capacity, refillIntervalMs: 15 * 60 * 1000 });
}

/** Count better-auth session rows for a user. */
function betterAuthSessions(db: Database.Database, userId: string): number {
  return (
    db.prepare(`SELECT count(*) AS c FROM session WHERE userId = ?`).get(userId) as {
      c: number;
    }
  ).c;
}

describe("loginWithCredentials", () => {
  it("succeeds with correct credentials and creates a better-auth session", async () => {
    const db = ctx.makeDb();
    const auth = makeAuth(db);
    const user = seedUser(db);
    const result = await loginWithCredentials(
      db,
      auth,
      { email: "Arda@viberr.test", password: PASSWORD, ip: "1.1.1.1" },
      { limiter: freshLimiter() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.id).toBe(user.id);
    expect(result.mustResetPassword).toBe(false);
    expect(
      result.setCookies.some((c) => c.includes("viberr.session_token")),
    ).toBe(true);
    expect(betterAuthSessions(db, user.id)).toBeGreaterThan(0);
    expect(findUserById(db, user.id)?.lastLoginAt).toBeTruthy();
    expect(
      listAuditEvents(db, { action: "auth.login.success" }),
    ).toHaveLength(1);
  });

  it("fails on wrong password (audits email only, no password)", async () => {
    const db = ctx.makeDb();
    seedUser(db);
    const result = await loginWithCredentials(
      db,
      makeAuth(db),
      { email: "arda@viberr.test", password: "wrong-password" },
      { limiter: freshLimiter() },
    );
    expect(result).toEqual({ ok: false, reason: "wrong_password" });
    const events = listAuditEvents(db, { action: "auth.login.failure" });
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toMatchObject({
      email: "arda@viberr.test",
      reason: "wrong_password",
    });
    expect(JSON.stringify(events[0])).not.toContain("wrong-password");
  });

  it("fails on unknown email", async () => {
    const db = ctx.makeDb();
    seedUser(db);
    const result = await loginWithCredentials(
      db,
      makeAuth(db),
      { email: "nobody@viberr.test", password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(result).toEqual({ ok: false, reason: "unknown_email" });
  });

  it("fails for a disabled user", async () => {
    const db = ctx.makeDb();
    const user = seedUser(db);
    db.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).run(user.id);
    const result = await loginWithCredentials(
      db,
      makeAuth(db),
      { email: user.email, password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(result).toEqual({ ok: false, reason: "disabled" });
  });

  it("fails for a passwordless (OAuth-only) account", async () => {
    const db = ctx.makeDb();
    seedUser(db, { id: "u_oauth", email: "o@viberr.test", passwordHash: null });
    const result = await loginWithCredentials(
      db,
      makeAuth(db),
      { email: "o@viberr.test", password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(result).toEqual({ ok: false, reason: "no_password" });
  });

  it("rate limits after 10 attempts per email+ip and audits the trip", async () => {
    const db = ctx.makeDb();
    const auth = makeAuth(db);
    seedUser(db);
    const limiter = freshLimiter();
    for (let i = 0; i < 10; i++) {
      await loginWithCredentials(
        db,
        auth,
        { email: "arda@viberr.test", password: "nope", ip: "2.2.2.2" },
        { limiter },
      );
    }
    const blocked = await loginWithCredentials(
      db,
      auth,
      { email: "arda@viberr.test", password: PASSWORD, ip: "2.2.2.2" },
      { limiter },
    );
    expect(blocked).toEqual({ ok: false, reason: "rate_limited" });
    expect(
      listAuditEvents(db, { action: "auth.login.rate_limited" }),
    ).toHaveLength(1);
    // A different ip is not affected.
    const otherIp = await loginWithCredentials(
      db,
      auth,
      { email: "arda@viberr.test", password: PASSWORD, ip: "3.3.3.3" },
      { limiter },
    );
    expect(otherIp.ok).toBe(true);
  });

  it("signals the forced-reset gate when pwreset_required is set", async () => {
    const db = ctx.makeDb();
    seedUser(db, { pwresetRequired: true });
    const result = await loginWithCredentials(
      db,
      makeAuth(db),
      { email: "arda@viberr.test", password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mustResetPassword).toBe(true);
  });
});

describe("completeForcedPasswordReset", () => {
  it("sets the new password on both stores and clears the flag", async () => {
    const db = ctx.makeDb();
    const auth = makeAuth(db);
    const user = seedUser(db, { pwresetRequired: true });
    const login = await loginWithCredentials(
      db,
      auth,
      { email: user.email, password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(login.ok).toBe(true);

    await completeForcedPasswordReset(db, {
      user,
      newPassword: "brand-new-password",
    });

    const fresh = findUserById(db, user.id)!;
    expect(fresh.pwresetRequired).toBe(false);
    expect(verifyPassword("brand-new-password", fresh.passwordHash)).toBe(true);
    expect(verifyPassword(PASSWORD, fresh.passwordHash)).toBe(false);

    // better-auth credential updated: new password signs in, old one doesn't.
    const good = await loginWithCredentials(
      db,
      auth,
      { email: user.email, password: "brand-new-password" },
      { limiter: freshLimiter() },
    );
    expect(good.ok).toBe(true);
    const bad = await loginWithCredentials(
      db,
      auth,
      { email: user.email, password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(bad).toEqual({ ok: false, reason: "wrong_password" });

    expect(
      listAuditEvents(db, { action: "auth.password.forced_reset_completed" }),
    ).toHaveLength(1);
  });

  it("rejects a too-short password", () => {
    const db = ctx.makeDb();
    const user = seedUser(db);
    expect(() =>
      completeForcedPasswordReset(db, { user, newPassword: "short" }),
    ).toThrowError(/at least 8/);
  });
});
