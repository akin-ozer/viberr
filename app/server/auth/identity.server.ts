import type { DatabaseSync } from "node:sqlite";
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
  /** better-auth credential hash (`<saltHex>:<keyHex>`, see
   *  `isBetterAuthPasswordHash`), or null for OAuth-only users. Naming the
   *  format matters: the retired hand-rolled auth ALSO used scrypt, in a
   *  different `scrypt$N$r$p$salt$key` encoding better-auth's verifier throws
   *  on, so "scrypt hash" alone does not say which of the two this is. */
  passwordHash: string | null;
}

/** Upserts the credential account carrying a user's better-auth password hash. */
function upsertCredential(
  db: DatabaseSync,
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
export function provisionIdentity(db: DatabaseSync, u: IdentityInput): void {
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
  db: DatabaseSync,
  userId: string,
  passwordHash: string,
): void {
  upsertCredential(db, userId, passwordHash);
}

export function credentialPasswordHash(
  db: DatabaseSync,
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

/**
 * True when `hash` is in Better Auth's own credential format (`<saltHex>:<keyHex>`
 * from `@better-auth/utils` scrypt). A stored hash that fails this — an empty
 * value, or the pre-better-auth `scrypt$N$r$p$salt$key` shape — makes Better
 * Auth's verifier throw "Invalid password hash" (an unrecoverable 500 on the
 * `/api/auth/*` splat). The seed uses this to re-hash a legacy credential back
 * into a working state (P11-01). Verification itself is made total separately
 * via the custom `password.verify` hook.
 */
export function isBetterAuthPasswordHash(hash: string | null | undefined): boolean {
  return typeof hash === "string" && /^[0-9a-f]+:[0-9a-f]+$/i.test(hash);
}

/** Syncs a user's email onto their better-auth identity (admin email edit). */
export function syncIdentityEmail(
  db: DatabaseSync,
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
  db: DatabaseSync,
  userId: string,
): number {
  return Number(
    db.prepare(`DELETE FROM session WHERE userId = ?`).run(userId).changes,
  );
}

/** Removes a user's better-auth identity (cascades session/account). */
export function deleteIdentity(db: DatabaseSync, userId: string): void {
  db.prepare(`DELETE FROM "user" WHERE id = ?`).run(userId);
}
