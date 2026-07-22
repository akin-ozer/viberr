import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { createAuth, type ViberrAuth } from "~/lib/auth.server";
import { hashPassword } from "./password.server";
import {
  CREDENTIAL_PROVIDER,
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
});
