import type { DatabaseSync } from "node:sqlite";
import { normalizeHandle } from "~/shared/github-handle";
import type { UserRole } from "~/shared/mapping/user.server";
import { recordAudit } from "../audit/audit-recorder.server";
import {
  findDomainAllowlistRole,
  githubPlaceholderEmail,
} from "../org/org-users.server";
import { deleteIdentity, provisionIdentity } from "./identity.server";
import {
  findUserByEmail,
  findUserById,
  insertUser,
  normalizeEmail,
  recordUserLogin,
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
 *   when the sign-in is GOOGLE and the email domain is in
 *   `google_domain_allowlist` (provisioned with the mapped role), or a
 *   GitHub-handle placeholder row exists (claimed). Anything else is rejected.
 *
 * P13-D-22: the domain rule is GOOGLE-ONLY, and the provider is now threaded in
 * rather than guessed. The table is named `google_domain_allowlist`, the README
 * says domain allowlisting is "for Google", and the in-app label reads "any
 * Google account with this domain" next to a "G" glyph — but the predicate took
 * no provider, ran the domain check first and unconditionally, and the better-
 * auth hook forwarded only `{id, email, name, githubHandle}`. Adding `@acme.com`
 * therefore also admitted any GITHUB account whose profile email happened to
 * end in `@acme.com` — an identity the org's Workspace admin cannot offboard.
 * Before the better-auth migration the two providers had strictly separate
 * paths; commit 745e19d collapsed them into one predicate.
 *
 * NOT LIVE-VERIFIED: this instance has no GitHub/Google OAuth credentials, so
 * the provider handshake can't be exercised here. The pure whitelist/provision
 * logic below is unit-tested (oauth-provision.server.test.ts); the handshake
 * itself is better-auth's own (well-tested) code.
 */

/** The social providers the app configures. `null` = the provider could not be
 *  read off the better-auth callback — treated as NOT Google (fail closed). */
export type OAuthProvider = "google" | "github";

export interface OAuthUser {
  id: string;
  email: string;
  name: string;
  githubHandle?: string | null;
  /** Which provider's callback is creating this user. Required: guessing it
   *  from the presence of `githubHandle` is what produced D-22. */
  provider: OAuthProvider | null;
}

/** create.before gate: is this NEW better-auth OAuth user allowed at all? */
export function isOAuthWhitelisted(
  db: DatabaseSync,
  user: OAuthUser,
): boolean {
  const email = normalizeEmail(user.email);
  const handle = normalizeHandle(user.githubHandle);
  // P13-D-22: domain admission is GOOGLE-ONLY — a Google Workspace domain is a
  // directory the org actually controls, which is the whole basis for trusting
  // it. A GitHub profile email is self-asserted and unmanageable, so it never
  // opens the domain door, whatever it ends in.
  if (user.provider === "google" && findDomainAllowlistRole(db, email)) {
    return true;
  }
  if (user.provider === "github" && handle) {
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
export function applyOAuthUser(db: DatabaseSync, user: OAuthUser): void {
  const email = normalizeEmail(user.email);
  const handle = normalizeHandle(user.githubHandle);
  // P13-D-22: the ROLE branch keys off the real callback provider. It used to
  // key off "does this profile carry a GitHub handle", so a GitHub sign-in
  // whose profile exposed no `login` took the Google branch and inherited a
  // domain-mapped role — and a GitHub sign-in that DID carry a handle but no
  // placeholder fell through to `member`, never the domain's mapped role.
  // `idp` still degrades to the old guess when the provider is unreadable, so
  // the stamped value stays one of local|github|google.
  const provider = user.provider ?? (handle ? "github" : "google");

  let role: UserRole = "member";

  if (user.provider === "github") {
    // Claim a `github.com/<handle>` placeholder by replacement (its role
    // carries over; the placeholder identity is removed). Without a placeholder
    // a GitHub sign-in has no role source — the domain allowlist is Google's.
    const placeholder = handle
      ? findUserByEmail(db, githubPlaceholderEmail(handle))
      : null;
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
  } else if (user.provider === "google") {
    role = findDomainAllowlistRole(db, email) ?? "member";
  }

  insertUser(db, {
    id: user.id,
    email,
    name: user.name?.trim() || email.split("@")[0] || email,
    role,
    idp: provider,
  });
  if (handle) updateUserFields(db, user.id, { githubHandle: handle });
  // Ensure the better-auth identity is normalized after the app row is created.
  provisionIdentity(db, {
    id: user.id,
    email,
    name: user.name?.trim() || email,
    passwordHash: null,
  });
  recordAudit(db, {
    action: "auth.oauth.user_provisioned",
    actor: { userId: user.id, label: email },
    subjectKind: "user",
    subjectId: user.id,
    details: { provider, email, role },
  });
}

/**
 * `session.create.after` — the seam that fires on EVERY sign-in.
 *
 * Only two hooks were wired before this: `user.create.after` (a brand-new
 * user) and `account.create.after` (the FIRST time a provider is linked).
 * Neither runs when an existing person simply signs in again, so:
 *
 *  - `users.last_login_at` was never stamped for an OAuth user, and the org
 *    Users list reads that column to decide "whitelisted" vs "active" — so
 *    every GitHub/Google member showed as never-signed-in forever;
 *  - a repeat sign-in left no audit row at all, on the one surface whose job
 *    is the record.
 *
 * It also mirrors better-auth's own `user.githubHandle` onto the legacy
 * `users.github_handle`. Doing it HERE rather than in `linkOAuth` is
 * deliberate: a session is created after both the account link and
 * `updateUserInfoOnLink`'s profile copy have run, so the value is settled by
 * the time this reads it, whatever order those take internally.
 */
export function recordSignIn(db: DatabaseSync, userId: string): void {
  const existing = findUserById(db, userId);
  if (!existing) return; // a session for a row this app does not own
  recordUserLogin(db, userId);

  // SAFETY: `githubHandle` is declared on better-auth's `user` table by
  // `user.additionalFields` (0001_baseline names the column), and the schema
  // types it TEXT — so the row either carries a string or NULL.
  const identity = db
    .prepare(`SELECT "githubHandle" FROM "user" WHERE id = ?`)
    .get(userId) as { githubHandle: string | null } | undefined;
  const handle = normalizeHandle(identity?.githubHandle);
  if (handle && handle !== existing.githubHandle) {
    updateUserFields(db, userId, { githubHandle: handle });
    recordAudit(db, {
      action: "auth.github_handle.recorded",
      actor: { userId, label: existing.email },
      subjectKind: "user",
      subjectId: userId,
      details: { handle },
    });
  }

  recordAudit(db, {
    action: "auth.sign_in",
    actor: { userId, label: existing.email },
    subjectKind: "user",
    subjectId: userId,
    details: { idp: existing.idp },
  });
}

/** account.create.after: stamp the last provider used on the legacy row. */
export function linkOAuth(
  db: DatabaseSync,
  userId: string,
  providerId: string,
): void {
  if (providerId !== "github" && providerId !== "google") return;
  const existing = db.prepare(`SELECT idp FROM users WHERE id = ?`).get(userId);
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
