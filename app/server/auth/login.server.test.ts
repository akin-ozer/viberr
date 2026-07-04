import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../audit/audit-recorder.server";
import {
  completeForcedPasswordReset,
  loginWithCredentials,
} from "./login.server";
import { hashPassword, verifyPassword } from "./password.server";
import { TokenBucketLimiter } from "./rate-limit.server";
import { getSessionByToken } from "./session.server";
import { findUserById, insertUser } from "./user-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const PASSWORD = "correct-password";

function seedUser(
  db: ReturnType<typeof ctx.makeDb>,
  overrides: Partial<Parameters<typeof insertUser>[1]> = {},
) {
  return insertUser(db, {
    id: "u_login",
    email: "arda@viberr.test",
    name: "Arda",
    role: "admin",
    passwordHash: hashPassword(PASSWORD),
    ...overrides,
  });
}

function freshLimiter(capacity = 10) {
  return new TokenBucketLimiter({ capacity, refillIntervalMs: 15 * 60 * 1000 });
}

describe("loginWithCredentials", () => {
  it("succeeds with correct credentials and creates a session", () => {
    const db = ctx.makeDb();
    const user = seedUser(db);
    const result = loginWithCredentials(
      db,
      { email: "Arda@viberr.test", password: PASSWORD, ip: "1.1.1.1" },
      { limiter: freshLimiter() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.id).toBe(user.id);
    expect(result.mustResetPassword).toBe(false);
    expect(getSessionByToken(db, result.session.token)?.session.userId).toBe(
      user.id,
    );
    expect(findUserById(db, user.id)?.lastLoginAt).toBeTruthy();
    expect(
      listAuditEvents(db, { action: "auth.login.success" }),
    ).toHaveLength(1);
  });

  it("fails on wrong password (audits email only, no password)", () => {
    const db = ctx.makeDb();
    seedUser(db);
    const result = loginWithCredentials(
      db,
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

  it("fails on unknown email", () => {
    const db = ctx.makeDb();
    seedUser(db);
    const result = loginWithCredentials(
      db,
      { email: "nobody@viberr.test", password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(result).toEqual({ ok: false, reason: "unknown_email" });
  });

  it("fails for a disabled user", () => {
    const db = ctx.makeDb();
    const user = seedUser(db);
    db.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).run(user.id);
    const result = loginWithCredentials(
      db,
      { email: user.email, password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(result).toEqual({ ok: false, reason: "disabled" });
  });

  it("fails for a passwordless (OAuth-only) account", () => {
    const db = ctx.makeDb();
    seedUser(db, { id: "u_oauth", email: "o@viberr.test", passwordHash: null });
    const result = loginWithCredentials(
      db,
      { email: "o@viberr.test", password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(result).toEqual({ ok: false, reason: "no_password" });
  });

  it("rate limits after 10 attempts per email+ip and audits the trip", () => {
    const db = ctx.makeDb();
    seedUser(db);
    const limiter = freshLimiter();
    for (let i = 0; i < 10; i++) {
      loginWithCredentials(
        db,
        { email: "arda@viberr.test", password: "nope", ip: "2.2.2.2" },
        { limiter },
      );
    }
    const blocked = loginWithCredentials(
      db,
      { email: "arda@viberr.test", password: PASSWORD, ip: "2.2.2.2" },
      { limiter },
    );
    expect(blocked).toEqual({ ok: false, reason: "rate_limited" });
    expect(
      listAuditEvents(db, { action: "auth.login.rate_limited" }),
    ).toHaveLength(1);
    // A different ip is not affected.
    const otherIp = loginWithCredentials(
      db,
      { email: "arda@viberr.test", password: PASSWORD, ip: "3.3.3.3" },
      { limiter },
    );
    expect(otherIp.ok).toBe(true);
  });

  it("signals the forced-reset gate when pwreset_required is set", () => {
    const db = ctx.makeDb();
    seedUser(db, { pwresetRequired: true });
    const result = loginWithCredentials(
      db,
      { email: "arda@viberr.test", password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mustResetPassword).toBe(true);
  });
});

describe("completeForcedPasswordReset", () => {
  it("sets the new password, clears the flag and rotates sessions", () => {
    const db = ctx.makeDb();
    const user = seedUser(db, { pwresetRequired: true });
    const login = loginWithCredentials(
      db,
      { email: user.email, password: PASSWORD },
      { limiter: freshLimiter() },
    );
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const { session } = completeForcedPasswordReset(db, {
      user,
      newPassword: "brand-new-password",
    });

    // Old session is gone; the new one works.
    expect(getSessionByToken(db, login.session.token)).toBeNull();
    expect(getSessionByToken(db, session.token)?.session.userId).toBe(user.id);

    const fresh = findUserById(db, user.id)!;
    expect(fresh.pwresetRequired).toBe(false);
    expect(verifyPassword("brand-new-password", fresh.passwordHash)).toBe(true);
    expect(verifyPassword(PASSWORD, fresh.passwordHash)).toBe(false);
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
