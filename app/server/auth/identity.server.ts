import type Database from "better-sqlite3";
import { newId } from "~/shared/ids/new-id.server";
import { normalizeEmail } from "./user-store.server";

/**
 * better-auth identity provisioning. better-auth OWNS credentials, sessions,
 * OAuth links; the `users` table stays the app's
 * canonical profile/role store. The single invariant that binds them is
 * better-auth `user.id` === `users.id`, so every profile/RBAC reader keeps
 * reading `users` untouched.
 *
 * Identities are created at the moment a user is created (seed, invite, OAuth)
 * — there is NO migration/backfill pass and NO legacy-session fallback. These
 * are plain synchronous row writes against better-auth's tables (the async
 * better-auth API is only used for the session read / sign-in / sign-out in the
 * route handlers, never here).
 *
 * Org roles remain in `users.role`; project roles remain file-native.
 */

/** Provider id better-auth uses for email+password credential accounts. */
export const CREDENTIAL_PROVIDER = "credential";

function nowIso(): string {
  return new Date().toISOString();
}

export interface IdentityInput {
  id: string;
  email: string;
  name: string;
  /** scrypt hash for a credential account, or null for OAuth-only users. */
  passwordHash: string | null;
}

/** Upserts the credential account carrying a user's scrypt hash. */
function upsertCredential(
  db: Database.Database,
  userId: string,
  passwordHash: string,
): void {
  const now = nowIso();
  const account = db
    .prepare(
      `SELECT id FROM account WHERE userId = ? AND providerId = ?`,
    )
    .get(userId, CREDENTIAL_PROVIDER) as { id: string } | undefined;
  if (account) {
    db.prepare(`UPDATE account SET password = ?, updatedAt = ? WHERE id = ?`).run(
      passwordHash,
      now,
      account.id,
    );
  } else {
    db.prepare(
      `INSERT INTO account
         (id, accountId, providerId, userId, password, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId("acct"), userId, CREDENTIAL_PROVIDER, userId, passwordHash, now, now);
  }
}

/**
 * Provisions a better-auth identity for a legacy user (id-preserving): the
 * `user` row and a credential `account` when the user has a password. Idempotent.
 */
export function provisionIdentity(db: Database.Database, u: IdentityInput): void {
  const now = nowIso();
  const email = normalizeEmail(u.email);

  const existing = db
    .prepare(`SELECT id FROM "user" WHERE id = ?`)
    .get(u.id) as { id: string } | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(u.id, u.name, email, now, now);
  } else {
    db.prepare(
      `UPDATE "user" SET name = ?, email = ?, updatedAt = ? WHERE id = ?`,
    ).run(u.name, email, now, u.id);
  }

  if (u.passwordHash) upsertCredential(db, u.id, u.passwordHash);

}

/** Sets/replaces a user's credential password hash (password change/reset). */
export function setCredentialPassword(
  db: Database.Database,
  userId: string,
  passwordHash: string,
): void {
  upsertCredential(db, userId, passwordHash);
}

export function credentialPasswordHash(
  db: Database.Database,
  userId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT password FROM account
       WHERE userId = ? AND providerId = ? AND password IS NOT NULL`,
    )
    .get(userId, CREDENTIAL_PROVIDER) as { password: string } | undefined;
  return row?.password ?? null;
}

/** Syncs a user's email onto their better-auth identity (admin email edit). */
export function syncIdentityEmail(
  db: Database.Database,
  userId: string,
  email: string,
): void {
  db.prepare(`UPDATE "user" SET email = ?, updatedAt = ? WHERE id = ?`).run(
    normalizeEmail(email),
    nowIso(),
    userId,
  );
}

/** Revokes every better-auth session of a user (disable / password change). */
export function revokeUserSessions(
  db: Database.Database,
  userId: string,
): number {
  return db.prepare(`DELETE FROM session WHERE userId = ?`).run(userId).changes;
}

/** Removes a user's better-auth identity (cascades session/account). */
export function deleteIdentity(db: Database.Database, userId: string): void {
  db.prepare(`DELETE FROM "user" WHERE id = ?`).run(userId);
}
