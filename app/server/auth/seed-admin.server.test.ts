import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import { credentialPasswordHash } from "./identity.server";
import { verifyPassword } from "./password.server";
import { seedInitialAdmin } from "./seed-admin.server";
import { findUserByEmail, insertUser, listUsers } from "./user-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("seedInitialAdmin", () => {
  it("creates the env-configured admin when the users table is empty", async () => {
    const db = ctx.makeDb();
    const result = await seedInitialAdmin(db, {
      email: "boss@example.com",
      password: "boss-password-1",
    });
    expect(result.created).toBe(true);
    expect(result.generatedPassword).toBeUndefined();

    const user = findUserByEmail(db, "boss@example.com")!;
    expect(user.role).toBe("admin");
    expect(user.pwresetRequired).toBe(false); // env password is known
    expect(user.name).toBe("Boss");
    await expect(
      verifyPassword("boss-password-1", credentialPasswordHash(db, user.id)),
    ).resolves.toBe(true);
    expect(listAuditEvents(db, { action: "org.user.created" })).toHaveLength(1);
  });

  it("defaults to arda@viberr.dev with a generated one-time password", async () => {
    const db = ctx.makeDb();
    const result = await seedInitialAdmin(db, {});
    expect(result.created).toBe(true);
    expect(result.email).toBe("arda@viberr.dev");
    expect(result.generatedPassword).toBeTruthy();

    const user = findUserByEmail(db, "arda@viberr.dev")!;
    expect(user.name).toBe("Arda Kaya");
    expect(user.pwresetRequired).toBe(true); // must change at first login
    await expect(
      verifyPassword(
        result.generatedPassword!,
        credentialPasswordHash(db, user.id),
      ),
    ).resolves.toBe(true);
  });

  it("is a no-op when any user exists", async () => {
    const db = ctx.makeDb();
    insertUser(db, {
      id: "u_existing",
      email: "someone@viberr.test",
      name: "Someone",
      role: "member",
    });
    const result = await seedInitialAdmin(db, { email: "boss@example.com" });
    expect(result.created).toBe(false);
    expect(listUsers(db)).toHaveLength(1);
  });
});
