import type Database from "better-sqlite3";
import { newId } from "~/shared/ids/new-id.server";
import type { UserRole } from "~/shared/mapping/user.server";
import { normalizeEmail } from "./user-store.server";

/**
 * better-auth identity provisioning. better-auth OWNS credentials, sessions,
 * OAuth links, and org membership; the legacy `users` table stays the app's
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
 * Single tenant: everyone belongs to ONE organization; `member.role` mirrors
 * `users.role` so the org-plugin membership surface is real while Viberr's own
 * hierarchical role check stays authoritative.
 */

export const DEFAULT_ORG_ID = "org_viberr";
export const DEFAULT_ORG_SLUG = "viberr";
export const DEFAULT_ORG_NAME = "Viberr";

/** Provider id better-auth uses for email+password credential accounts. */
export const CREDENTIAL_PROVIDER = "credential";

function nowIso(): string {
  return new Date().toISOString();
}

/** Creates the single Viberr organization if it does not exist yet. */
export function ensureDefaultOrg(db: Database.Database): void {
  const exists = db
    .prepare(`SELECT 1 FROM organization WHERE id = ?`)
    .get(DEFAULT_ORG_ID);
  if (exists) return;
  db.prepare(
    `INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`,
  ).run(DEFAULT_ORG_ID, DEFAULT_ORG_NAME, DEFAULT_ORG_SLUG, nowIso());
}

export interface IdentityInput {
  id: string;
  email: string;
  name: string;
  /** scrypt hash for a credential account, or null for OAuth-only users. */
  passwordHash: string | null;
  role: UserRole;
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
 * `user` row, a credential `account` (when the user has a password), and a
 * `member` row in the default org carrying the org role. Idempotent.
 */
export function provisionIdentity(db: Database.Database, u: IdentityInput): void {
  ensureDefaultOrg(db);
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

  const member = db
    .prepare(
      `SELECT id FROM member WHERE userId = ? AND organizationId = ?`,
    )
    .get(u.id, DEFAULT_ORG_ID) as { id: string } | undefined;
  if (!member) {
    db.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(newId("mem"), DEFAULT_ORG_ID, u.id, u.role, now);
  } else {
    db.prepare(`UPDATE member SET role = ? WHERE id = ?`).run(u.role, member.id);
  }
}

/** Sets/replaces a user's credential password hash (password change/reset). */
export function setCredentialPassword(
  db: Database.Database,
  userId: string,
  passwordHash: string,
): void {
  upsertCredential(db, userId, passwordHash);
}

/** Sets a user's org-role on their membership (the source of truth). */
export function setMemberRole(
  db: Database.Database,
  userId: string,
  role: UserRole,
): void {
  db.prepare(
    `UPDATE member SET role = ? WHERE userId = ? AND organizationId = ?`,
  ).run(role, userId, DEFAULT_ORG_ID);
}

/**
 * The AUTHORITATIVE org role for a user — the better-auth org-plugin membership
 * (`member.role` in the default org). Option-B cutover (pass-4 ruling 5): the
 * `member` table is the org-role source and `users.role` is a derived cache.
 * Falls back to `fallback` (the legacy `users.role`) only when a membership row
 * is somehow absent, so an un-provisioned user is never silently demoted.
 */
export function resolveOrgRole(
  db: Database.Database,
  userId: string,
  fallback: UserRole,
): UserRole {
  const row = db
    .prepare(
      `SELECT role FROM member WHERE userId = ? AND organizationId = ?`,
    )
    .get(userId, DEFAULT_ORG_ID) as { role: string } | undefined;
  if (!row) return fallback;
  return row.role === "admin" ? "admin" : "member";
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

/** Removes a user's better-auth identity (cascades session/account/member). */
export function deleteIdentity(db: Database.Database, userId: string): void {
  db.prepare(`DELETE FROM "user" WHERE id = ?`).run(userId);
}
