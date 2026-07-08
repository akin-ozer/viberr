import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "~/shared/ids/new-id.server";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../audit/audit-recorder.server";
import { isAppError } from "../errors/app-error.server";
import { verifyPassword } from "./password.server";
import {
  createUser,
  disableUser,
  enableUser,
  resetPassword,
  updateUser,
} from "./user-admin.server";
import { findUserByEmail, findUserById, insertUser } from "./user-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ACTOR = { userId: "u_admin", label: "admin@viberr.test" };

/** Inserts a better-auth session row for a user (identity must exist). */
function seedSession(db: Database.Database, userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("sess"),
    new Date(Date.now() + 1_000_000_000).toISOString(),
    newId("tok"),
    now,
    now,
    userId,
  );
}

function sessionCount(db: Database.Database, userId: string): number {
  return (
    db.prepare(`SELECT count(*) AS c FROM session WHERE userId = ?`).get(userId) as {
      c: number;
    }
  ).c;
}

function seedAdmin(db: ReturnType<typeof ctx.makeDb>) {
  return insertUser(db, {
    id: "u_admin",
    email: "admin@viberr.test",
    name: "Admin",
    role: "admin",
  });
}

describe("createUser", () => {
  it("creates a user with a temp password (pwreset forced)", () => {
    const db = ctx.makeDb();
    seedAdmin(db);
    const user = createUser(
      db,
      {
        email: "New.Person@Viberr.Test",
        name: "New Person",
        role: "member",
        tempPassword: "temp-pass-123",
      },
      ACTOR,
    );
    expect(user.email).toBe("new.person@viberr.test"); // normalized
    expect(user.role).toBe("member");
    expect(user.pwresetRequired).toBe(true);
    expect(user.createdBy).toBe("u_admin");
    expect(verifyPassword("temp-pass-123", user.passwordHash)).toBe(true);
    expect(listAuditEvents(db, { action: "org.user.created" })).toHaveLength(1);
  });

  it("creates a passwordless OAuth-only user", () => {
    const db = ctx.makeDb();
    seedAdmin(db);
    const user = createUser(
      db,
      { email: "oauth@viberr.test", name: "O Auth", role: "member" },
      ACTOR,
    );
    expect(user.passwordHash).toBeNull();
    expect(user.pwresetRequired).toBe(false);
  });

  it("rejects invalid input and duplicates", () => {
    const db = ctx.makeDb();
    seedAdmin(db);
    expect(() =>
      createUser(db, { email: "not-an-email", name: "X", role: "member" }, ACTOR),
    ).toThrowError(/valid email/i);
    expect(() =>
      createUser(
        db,
        { email: "a@viberr.test", name: "X", role: "member", tempPassword: "short" },
        ACTOR,
      ),
    ).toThrowError(/at least 8/);
    createUser(db, { email: "dup@viberr.test", name: "A", role: "member" }, ACTOR);
    try {
      createUser(db, { email: "DUP@viberr.test", name: "B", role: "member" }, ACTOR);
      expect.unreachable("duplicate email must throw");
    } catch (error) {
      expect(isAppError(error) && error.status === 409).toBe(true);
    }
  });
});

describe("updateUser", () => {
  it("updates role/name/title and audits the change", () => {
    const db = ctx.makeDb();
    seedAdmin(db);
    const user = createUser(
      db,
      { email: "m@viberr.test", name: "Member", role: "member" },
      ACTOR,
    );
    const updated = updateUser(
      db,
      user.id,
      { role: "admin", name: "Renamed", title: "Ops" },
      ACTOR,
    );
    expect(updated.role).toBe("admin");
    expect(updated.name).toBe("Renamed");
    expect(updated.title).toBe("Ops");
    const events = listAuditEvents(db, { action: "org.user.updated" });
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toMatchObject({ roleFrom: "member", roleTo: "admin" });
  });

  it("disable destroys the user's sessions", () => {
    const db = ctx.makeDb();
    seedAdmin(db);
    const user = createUser(
      db,
      { email: "d@viberr.test", name: "D", role: "member" },
      ACTOR,
    );
    seedSession(db, user.id);
    disableUser(db, user.id, ACTOR);
    expect(findUserById(db, user.id)?.disabled).toBe(true);
    expect(sessionCount(db, user.id)).toBe(0);
    expect(listAuditEvents(db, { action: "org.user.disabled" })).toHaveLength(1);
    enableUser(db, user.id, ACTOR);
    expect(findUserById(db, user.id)?.disabled).toBe(false);
    expect(listAuditEvents(db, { action: "org.user.enabled" })).toHaveLength(1);
  });

  it("refuses to demote or disable the last active admin", () => {
    const db = ctx.makeDb();
    const admin = seedAdmin(db);
    for (const attempt of [
      () => updateUser(db, admin.id, { role: "member" }, ACTOR),
      () => disableUser(db, admin.id, ACTOR),
    ]) {
      try {
        attempt();
        expect.unreachable("last-admin guard must throw");
      } catch (error) {
        expect(isAppError(error) && error.status === 409).toBe(true);
      }
    }
    // With a second admin, demotion works.
    createUser(
      db,
      { email: "second@viberr.test", name: "Second", role: "admin" },
      ACTOR,
    );
    expect(updateUser(db, admin.id, { role: "member" }, ACTOR).role).toBe(
      "member",
    );
  });
});

describe("resetPassword", () => {
  it("sets a temp password, forces reset, kills sessions, audits", () => {
    const db = ctx.makeDb();
    seedAdmin(db);
    const user = createUser(
      db,
      {
        email: "r@viberr.test",
        name: "R",
        role: "member",
        tempPassword: "first-password",
      },
      ACTOR,
    );
    db.prepare(`UPDATE users SET pwreset_required = 0 WHERE id = ?`).run(user.id);
    seedSession(db, user.id);

    const updated = resetPassword(db, user.id, "new-temp-pass", ACTOR);
    expect(updated.pwresetRequired).toBe(true);
    expect(verifyPassword("new-temp-pass", updated.passwordHash)).toBe(true);
    expect(verifyPassword("first-password", updated.passwordHash)).toBe(false);
    expect(sessionCount(db, user.id)).toBe(0);
    expect(listAuditEvents(db, { action: "auth.password.reset" })).toHaveLength(1);
  });

  it("enforces the temp password policy", () => {
    const db = ctx.makeDb();
    const admin = seedAdmin(db);
    expect(() => resetPassword(db, admin.id, "short", ACTOR)).toThrowError(
      /at least 8/,
    );
  });
});

describe("email normalization", () => {
  it("finds users case-insensitively", () => {
    const db = ctx.makeDb();
    seedAdmin(db);
    expect(findUserByEmail(db, "ADMIN@VIBERR.TEST")?.id).toBe("u_admin");
  });
});
