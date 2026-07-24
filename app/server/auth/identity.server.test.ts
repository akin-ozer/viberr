import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { createAuth, type ViberrAuth } from "~/lib/auth.server";
import { hashPassword } from "./password.server";
import {
  CREDENTIAL_PROVIDER,
  isBetterAuthPasswordHash,
  provisionIdentity,
  revokeUserSessions,
  setCredentialPassword,
  syncIdentityEmail,
} from "./identity.server";

/**
 * Identity provisioning writes better-auth rows with plain synchronous SQL.
 * The critical guarantee: a raw-provisioned credential account signs in through
 * better-auth (dates/booleans stored in a shape better-auth reads back).
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function auth(db: DatabaseSync): ViberrAuth {
  return createAuth({
    db,
    secret: "test-secret-at-least-32-characters-long-000",
    baseURL: "http://localhost:5173",
    trustedOrigins: ["http://localhost:5173"],
  });
}

describe("identity provisioning", () => {
  it("provisions user + credential; the credential signs in", async () => {
    const db = ctx.makeDb();
    const a = auth(db);
    provisionIdentity(db, {
      id: "u_arda",
      email: "Arda@Viberr.Dev",
      name: "Arda",
      passwordHash: await hashPassword("viberr-dev-2828"),
    });

    // Identity id-preserving, email lowercased, emailVerified set.
    const user = db
      .prepare(`SELECT id, email, emailVerified FROM "user" WHERE id='u_arda'`)
      .get() as { id: string; email: string; emailVerified: number };
    expect(user).toEqual({ id: "u_arda", email: "arda@viberr.dev", emailVerified: 1 });

    const acct = db
      .prepare(`SELECT providerId, password FROM account WHERE userId='u_arda'`)
      .get() as { providerId: string; password: string };
    expect(acct.providerId).toBe(CREDENTIAL_PROVIDER);

    // The raw-provisioned credential verifies through better-auth sign-in.
    const res = await a.api.signInEmail({
      body: { email: "arda@viberr.dev", password: "viberr-dev-2828" },
      asResponse: true,
    });
    expect(res.status).toBe(200);
  });

  it("syncIdentityEmail updates the better-auth user email (WI-2)", async () => {
    const db = ctx.makeDb();
    provisionIdentity(db, {
      id: "u_e",
      email: "old@viberr.dev",
      name: "E",
      passwordHash: await hashPassword("secret-secret"),
    });
    syncIdentityEmail(db, "u_e", "New@Viberr.Dev");
    const row = db
      .prepare(`SELECT email FROM "user" WHERE id='u_e'`)
      .get() as { email: string };
    expect(row.email).toBe("new@viberr.dev");
  });

  it("is idempotent (no duplicate user/account on re-provision)", async () => {
    const db = ctx.makeDb();
    const input = {
      id: "u_x",
      email: "x@viberr.dev",
      name: "X",
      passwordHash: await hashPassword("secret-secret"),
    };
    provisionIdentity(db, input);
    provisionIdentity(db, input);
    const counts = db
      .prepare(
        `SELECT
           (SELECT count(*) FROM "user" WHERE id='u_x') AS users,
           (SELECT count(*) FROM account WHERE userId='u_x') AS accts`,
      )
      .get() as { users: number; accts: number };
    expect(counts).toEqual({ users: 1, accts: 1 });
  });

  it("setCredentialPassword swaps the sign-in password; revokeUserSessions clears sessions", async () => {
    const db = ctx.makeDb();
    const a = auth(db);
    provisionIdentity(db, {
      id: "u_p",
      email: "p@viberr.dev",
      name: "P",
      passwordHash: await hashPassword("old-password-1"),
    });
    // Establish a session, then revoke it.
    const signIn = await a.api.signInEmail({
      body: { email: "p@viberr.dev", password: "old-password-1" },
      asResponse: true,
    });
    expect(signIn.status).toBe(200);
    expect(
      (db.prepare(`SELECT count(*) AS c FROM session WHERE userId='u_p'`).get() as { c: number }).c,
    ).toBe(1);
    expect(revokeUserSessions(db, "u_p")).toBe(1);
    expect(
      (db.prepare(`SELECT count(*) AS c FROM session WHERE userId='u_p'`).get() as { c: number }).c,
    ).toBe(0);

    // New password verifies, old one no longer does.
    setCredentialPassword(db, "u_p", await hashPassword("new-password-2"));
    const good = await a.api.signInEmail({
      body: { email: "p@viberr.dev", password: "new-password-2" },
      asResponse: true,
    });
    expect(good.status).toBe(200);
    await expect(
      a.api.signInEmail({ body: { email: "p@viberr.dev", password: "old-password-1" } }),
    ).rejects.toBeTruthy();
  });

  it("a legacy/unverifiable credential hash reads as a wrong password (401), not a 500 (P11-01)", async () => {
    const db = ctx.makeDb();
    const a = auth(db);
    provisionIdentity(db, {
      id: "u_legacy",
      email: "legacy@viberr.dev",
      name: "Legacy",
      passwordHash: await hashPassword("placeholder-pw"),
    });
    // Overwrite with a pre-better-auth scrypt hash the built-in verifier throws
    // on. Without the total `password.verify` hook this surfaces as an unhandled
    // 500 on the splat; with it, verification returns false → 401.
    const legacyHash =
      "scrypt$16384$8$1$firuPx6uzlhAacmTd73at1OAoHciD9IbvW83I1VQvO0=$pX5ob5jrx1kC1KRCGKpsYCtiHZNXCQPO9zbo8RsKN9aRNG7aA3uG0plZc9JfpeL/DQk8A+iAx+cvrJmgwaRfdg==";
    setCredentialPassword(db, "u_legacy", legacyHash);
    const res = await a.api.signInEmail({
      body: { email: "legacy@viberr.dev", password: "placeholder-pw" },
      asResponse: true,
    });
    expect(res.status).toBe(401);
  });

  it("isBetterAuthPasswordHash distinguishes the current format from legacy/empty", async () => {
    expect(isBetterAuthPasswordHash(await hashPassword("some-password"))).toBe(true);
    expect(isBetterAuthPasswordHash("scrypt$16384$8$1$abc$def")).toBe(false);
    expect(isBetterAuthPasswordHash("")).toBe(false);
    expect(isBetterAuthPasswordHash(null)).toBe(false);
  });

  it("404s every endpoint outside the driven allow-list, keeps sign-in reachable (P11-02)", async () => {
    const db = ctx.makeDb();
    const a = auth(db);
    provisionIdentity(db, {
      id: "u_b",
      email: "blocked@viberr.dev",
      name: "B",
      passwordHash: await hashPassword("some-password"),
    });
    const post = (path: string, body: unknown) =>
      a.handler(
        new Request(`http://localhost:5173/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    // A sample of built-in endpoints the app does NOT drive — the account
    // mutations the old deny-list named, plus ones it missed (link-social,
    // revoke-sessions): under the ALLOW-list they all 404 without enumeration.
    for (const path of [
      "/change-password",
      "/update-user",
      "/delete-user",
      "/forget-password",
      "/reset-password",
      "/request-password-reset",
      "/link-social",
      "/revoke-sessions",
    ]) {
      const res = await post(path, { email: "blocked@viberr.dev" });
      expect(res.status, `${path} should be blocked`).toBe(404);
    }
    // The endpoints the app DOES drive stay reachable.
    const ok = await post("/sign-in/email", {
      email: "blocked@viberr.dev",
      password: "some-password",
    });
    expect(ok.status).toBe(200);
  });
});
