import type Database from "better-sqlite3";
import type { UserRole } from "~/shared/mapping/user.server";
import { recordAudit } from "../audit/audit-recorder.server";
import {
  findDomainAllowlistRole,
  githubPlaceholderEmail,
} from "../org/org-users.server";
import { deleteIdentity, provisionIdentity } from "./identity.server";
import {
  findUserByEmail,
  insertUser,
  normalizeEmail,
  updateUserFields,
} from "./user-store.server";

/**
 * OAuth whitelist + provisioning for better-auth social sign-in. better-auth
 * owns the OAuth handshake, account linking, and session; these synchronous
 * helpers are what its `databaseHooks` call to keep the legacy `users` table
 * (the canonical profile/RBAC store) in step.
 *
 * Whitelist (no open self-signup):
 * - An already-provisioned user (created by an admin, seeded, or domain-
 *   allowlisted before) signs in and better-auth ACCOUNT-LINKS by verified
 *   email — no user is created, so the create hooks never fire; `linkOAuth`
 *   only stamps the provider.
 * - Otherwise a NEW better-auth user is about to be created. It is allowed only
 *   when the email domain is in `google_domain_allowlist` (provisioned with the
 *   mapped role) or a GitHub-handle placeholder row exists (claimed). Anything
 *   else is rejected.
 *
 * NOT LIVE-VERIFIED: this instance has no GitHub/Google OAuth credentials, so
 * the provider handshake can't be exercised here. The pure whitelist/provision
 * logic below is unit-tested (oauth-provision.server.test.ts); the handshake
 * itself is better-auth's own (well-tested) code.
 */

export interface OAuthUser {
  id: string;
  email: string;
  name: string;
  githubHandle?: string | null;
}

function normalizeHandle(handle: string | null | undefined): string | null {
  return handle?.trim().replace(/^@/, "").toLowerCase() || null;
}

/** create.before gate: is this NEW better-auth OAuth user allowed at all? */
export function isOAuthWhitelisted(
  db: Database.Database,
  user: OAuthUser,
): boolean {
  const email = normalizeEmail(user.email);
  const handle = normalizeHandle(user.githubHandle);
  if (findDomainAllowlistRole(db, email)) return true;
  if (handle) {
    const placeholder = findUserByEmail(db, githubPlaceholderEmail(handle));
    if (placeholder && !placeholder.disabled) return true;
  }
  // Safety net: a live legacy row that (anomalously) was not account-linked.
  const existing = findUserByEmail(db, email);
  return Boolean(existing && !existing.disabled);
}

/**
 * create.after: materialize the legacy `users` row (id === better-auth id) +
 * membership for a freshly created OAuth user, resolving its role from the
 * domain allowlist or a claimed GitHub-handle placeholder.
 */
export function applyOAuthUser(db: Database.Database, user: OAuthUser): void {
  const email = normalizeEmail(user.email);
  const handle = normalizeHandle(user.githubHandle);
  const provider = handle ? "github" : "google";

  let role: UserRole = "member";

  if (handle) {
    // Claim a `github.com/<handle>` placeholder by replacement (its role
    // carries over; the placeholder identity is removed).
    const placeholder = findUserByEmail(db, githubPlaceholderEmail(handle));
    if (placeholder) {
      role = placeholder.role;
      deleteIdentity(db, placeholder.id);
      db.prepare(`DELETE FROM users WHERE id = ?`).run(placeholder.id);
      recordAudit(db, {
        action: "auth.oauth.placeholder_claimed",
        actor: { userId: user.id, label: email },
        subjectKind: "user",
        subjectId: user.id,
        details: { provider: "github", handle, email },
      });
    }
  } else {
    role = findDomainAllowlistRole(db, email) ?? "member";
  }

  insertUser(db, {
    id: user.id,
    email,
    name: user.name?.trim() || email.split("@")[0] || email,
    role,
    passwordHash: null, // OAuth-only account
    idp: provider,
  });
  if (handle) updateUserFields(db, user.id, { githubHandle: handle });
  // Membership for the new better-auth user (idempotent; the user row itself
  // was just created by better-auth).
  provisionIdentity(db, {
    id: user.id,
    email,
    name: user.name?.trim() || email,
    passwordHash: null,
    role,
  });
  recordAudit(db, {
    action: "auth.oauth.user_provisioned",
    actor: { userId: user.id, label: email },
    subjectKind: "user",
    subjectId: user.id,
    details: { provider, email, role },
  });
}

/** account.create.after: stamp the last provider used on the legacy row. */
export function linkOAuth(
  db: Database.Database,
  userId: string,
  providerId: string,
): void {
  if (providerId !== "github" && providerId !== "google") return;
  const existing = db
    .prepare(`SELECT idp FROM users WHERE id = ?`)
    .get(userId) as { idp: string } | undefined;
  if (existing && existing.idp !== providerId) {
    updateUserFields(db, userId, { idp: providerId });
  }
  recordAudit(db, {
    action: "auth.oauth.login",
    actor: { userId, label: userId },
    subjectKind: "user",
    subjectId: userId,
    details: { provider: providerId },
  });
}
