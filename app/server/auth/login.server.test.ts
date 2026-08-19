import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { createAuth, type ViberrAuth } from "~/lib/auth.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  completeForcedPasswordReset,
  loginWithCredentials,
} from "./login.server";
import { credentialPasswordHash, provisionIdentity } from "./identity.server";
import { hashPassword, verifyPassword } from "./password.server";
import { SOCIAL_START_RATE_LIMIT } from "./rate-limit.server";
import { findUserById, insertUser } from "./user-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const PASSWORD = "correct-password";

function makeAuth(db: DatabaseSync): ViberrAuth {
  return createAuth({
    db,
    secret: "test-secret-at-least-32-characters-long-000",
    baseURL: "http://localhost:5173",
    trustedOrigins: ["http://localhost:5173"],
  });
}

async function seedUser(
  db: DatabaseSync,
  overrides: Partial<Parameters<typeof insertUser>[1]> = {},
  password: string | null = PASSWORD,
) {
  const user = insertUser(db, {
    id: "u_login",
    email: "arda@viberr.test",
    name: "Arda",
    role: "admin",
    ...overrides,
  });
  provisionIdentity(db, {
    id: user.id,
    email: user.email,
    name: user.name,
    passwordHash: password === null ? null : await hashPassword(password),
  });
  return findUserById(db, user.id)!;
}

function requestDeps(ip: string) {
  return {
    requestHeaders: new Headers({ "X-Forwarded-For": ip }),
    requestUrl: "http://localhost:5173/login",
  };
}

/** Count better-auth session rows for a user. */
function betterAuthSessions(db: DatabaseSync, userId: string): number {
  // SAFETY: `count(*)` is an aggregate with no GROUP BY — sqlite answers it with
  // exactly one row carrying the single integer column `c`.
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
    const user = await seedUser(db);
    const result = await loginWithCredentials(
      db,
      auth,
      { email: "Arda@viberr.test", password: PASSWORD },
      requestDeps("192.0.2.1"),
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
    await seedUser(db);
    const result = await loginWithCredentials(
      db,
      makeAuth(db),
      { email: "arda@viberr.test", password: "wrong-password" },
      requestDeps("192.0.2.2"),
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
    await seedUser(db);
    const result = await loginWithCredentials(
      db,
      makeAuth(db),
      { email: "nobody@viberr.test", password: PASSWORD },
      requestDeps("192.0.2.3"),
    );
    expect(result).toEqual({ ok: false, reason: "unknown_email" });
  });

  it("fails for a disabled user", async () => {
    const db = ctx.makeDb();
    const user = await seedUser(db);
    db.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).run(user.id);
    const result = await loginWithCredentials(
      db,
      makeAuth(db),
      { email: user.email, password: PASSWORD },
      requestDeps("192.0.2.4"),
    );
    expect(result).toEqual({ ok: false, reason: "disabled" });
  });

  it("fails for a passwordless (OAuth-only) account", async () => {
    const db = ctx.makeDb();
    await seedUser(db, { id: "u_oauth", email: "o@viberr.test" }, null);
    const result = await loginWithCredentials(
      db,
      makeAuth(db),
      { email: "o@viberr.test", password: PASSWORD },
      requestDeps("192.0.2.5"),
    );
    expect(result).toEqual({ ok: false, reason: "no_password" });
  });

  it("throttles after 10 attempts per email+ip and audits the trip", async () => {
    const db = ctx.makeDb();
    const auth = makeAuth(db);
    await seedUser(db);
    for (let i = 0; i < 10; i++) {
      await loginWithCredentials(
        db,
        auth,
        { email: "arda@viberr.test", password: "nope" },
        requestDeps("192.0.2.6"),
      );
    }
    const blocked = await loginWithCredentials(
      db,
      auth,
      { email: "arda@viberr.test", password: PASSWORD },
      requestDeps("192.0.2.6"),
    );
    expect(blocked).toEqual({ ok: false, reason: "rate_limited" });
    expect(
      listAuditEvents(db, { action: "auth.login.rate_limited" }),
    ).toHaveLength(1);
    // A different IP is not affected.
    const otherIp = await loginWithCredentials(
      db,
      auth,
      { email: "arda@viberr.test", password: PASSWORD },
      requestDeps("192.0.2.7"),
    );
    expect(otherIp.ok).toBe(true);
  });

  it("a spent bucket never denies a different email on the same ip", async () => {
    const db = ctx.makeDb();
    const auth = makeAuth(db);
    await seedUser(db);
    const victim = await seedUser(db, {
      id: "u_victim",
      email: "murat@viberr.test",
      name: "Murat",
    });
    // One attacker, one ip, burning through a single account's whole bucket.
    const deps = requestDeps("192.0.2.10");
    for (let i = 0; i < 12; i++) {
      await loginWithCredentials(
        db,
        auth,
        { email: "arda@viberr.test", password: "nope" },
        deps,
      );
    }
    expect(
      await loginWithCredentials(
        db,
        auth,
        { email: "arda@viberr.test", password: PASSWORD },
        deps,
      ),
    ).toEqual({ ok: false, reason: "rate_limited" });
    // Everyone else still signs in — the bucket key carries the email, and
    // Better Auth's ip-keyed (org-wide, proxy-less) limiter is off for
    // /sign-in/email so it cannot lock the org out either.
    const other = await loginWithCredentials(
      db,
      auth,
      { email: victim.email, password: PASSWORD },
      deps,
    );
    expect(other.ok).toBe(true);
  });

  it("throttles a POST straight to /api/auth/sign-in/email, bypassing the login action", async () => {
    // /api/auth/* is mounted as a splat (routes/api.auth.$.ts), so better-auth
    // is reachable without going through loginWithCredentials. Throttling only
    // in the login action would leave unlimited password guesses on this path.
    const db = ctx.makeDb();
    const auth = makeAuth(db);
    await seedUser(db);
    const post = () =>
      auth.handler(
        new Request("http://localhost:5173/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:5173",
            "X-Forwarded-For": "192.0.2.44",
          },
          body: JSON.stringify({ email: "arda@viberr.test", password: "nope" }),
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post()).status);
    // The first 10 are ordinary auth failures; the 11th trips the bucket.
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Keyed on email+ip, so a different account on that ip still gets in.
    const other = await loginWithCredentials(
      db,
      auth,
      { email: "arda@viberr.test", password: PASSWORD },
      requestDeps("192.0.2.45"),
    );
    expect(other.ok).toBe(true);
  });

  it("signals the forced-reset gate when pwreset_required is set", async () => {
    const db = ctx.makeDb();
    await seedUser(db, { pwresetRequired: true });
    const result = await loginWithCredentials(
      db,
      makeAuth(db),
      { email: "arda@viberr.test", password: PASSWORD },
      requestDeps("192.0.2.8"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mustResetPassword).toBe(true);
  });
});

describe("completeForcedPasswordReset", () => {
  it("sets the new password on both stores and clears the flag", async () => {
    const db = ctx.makeDb();
    const auth = makeAuth(db);
    const user = await seedUser(db, { pwresetRequired: true });
    const login = await loginWithCredentials(
      db,
      auth,
      { email: user.email, password: PASSWORD },
      requestDeps("192.0.2.9"),
    );
    expect(login.ok).toBe(true);

    await completeForcedPasswordReset(db, {
      user,
      newPassword: "brand-new-password",
    });

    const fresh = findUserById(db, user.id)!;
    const passwordHash = credentialPasswordHash(db, user.id);
    expect(fresh.pwresetRequired).toBe(false);
    await expect(verifyPassword("brand-new-password", passwordHash)).resolves.toBe(
      true,
    );
    await expect(verifyPassword(PASSWORD, passwordHash)).resolves.toBe(false);

    // better-auth credential updated: new password signs in, old one doesn't.
    const good = await loginWithCredentials(
      db,
      auth,
      { email: user.email, password: "brand-new-password" },
      requestDeps("192.0.2.9"),
    );
    expect(good.ok).toBe(true);
    const bad = await loginWithCredentials(
      db,
      auth,
      { email: user.email, password: PASSWORD },
      requestDeps("192.0.2.9"),
    );
    expect(bad).toEqual({ ok: false, reason: "wrong_password" });

    expect(
      listAuditEvents(db, { action: "auth.password.forced_reset_completed" }),
    ).toHaveLength(1);
  });

  it("rejects a too-short password", async () => {
    const db = ctx.makeDb();
    const user = await seedUser(db);
    await expect(
      completeForcedPasswordReset(db, { user, newPassword: "short" }),
    ).rejects.toThrowError(/at least 8/);
  });
});

/**
 * `/sign-in/social` is reachable through the `/api/auth/*` splat and is POSTed
 * by both login.tsx and profile-page.tsx. Better Auth's built-in limiter keys
 * on the client ip, which is null on this proxy-less deployment, so its default
 * `/sign-in` rule (3 per 10s) collapses to ONE org-wide bucket — a handful of
 * simultaneous "Sign in with GitHub" clicks denies social sign-in to everyone.
 * The rule is set to `false` and the app bucket in the `before` hook takes over.
 */
describe("social sign-in throttle", () => {
  function makeSocialAuth(db: DatabaseSync): ViberrAuth {
    return createAuth({
      db,
      secret: "test-secret-at-least-32-characters-long-000",
      baseURL: "http://localhost:5173",
      trustedOrigins: ["http://localhost:5173"],
      github: { clientId: "gh-client", clientSecret: "gh-secret" },
      google: { clientId: "goog-client", clientSecret: "goog-secret" },
    });
  }

  function startSocial(auth: ViberrAuth, provider: string, ip: string) {
    return auth.handler(
      new Request("http://localhost:5173/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ provider, callbackURL: "/" }),
      }),
    );
  }

  it("does not lock the org out after a few simultaneous starts", async () => {
    const auth = makeSocialAuth(ctx.makeDb());
    // Better Auth's default rule would 429 the 4th of these.
    for (let i = 0; i < 8; i++) {
      const res = await startSocial(auth, "github", "192.0.2.30");
      expect(res.status).not.toBe(429);
    }
  });

  it("throttles at the app capacity, and per provider", async () => {
    const auth = makeSocialAuth(ctx.makeDb());
    for (let i = 0; i < SOCIAL_START_RATE_LIMIT.capacity; i++) {
      const res = await startSocial(auth, "github", "192.0.2.31");
      expect(res.status).not.toBe(429);
    }
    const blocked = await startSocial(auth, "github", "192.0.2.31");
    expect(blocked.status).toBe(429);
    // The key carries the provider, so exhausting GitHub never denies Google…
    const otherProvider = await startSocial(auth, "google", "192.0.2.31");
    expect(otherProvider.status).not.toBe(429);
    // …and behind a real proxy the ip separates callers too.
    const otherIp = await startSocial(auth, "github", "192.0.2.32");
    expect(otherIp.status).not.toBe(429);
  });
});
