import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type Database from "better-sqlite3";
import type { UserRecord } from "~/shared/mapping/user.server";
import { newId } from "~/shared/ids/new-id.server";
import { recordAudit } from "../audit/audit-recorder.server";
import {
  findDomainAllowlistRole,
  githubPlaceholderEmail,
} from "../org/org-users.server";
import {
  createSession,
  type CreatedSession,
  type SessionMeta,
} from "./session.server";
import {
  findUserByEmail,
  insertUser,
  normalizeEmail,
  recordUserLogin,
  updateUserFields,
} from "./user-store.server";

/**
 * Shared OAuth plumbing: state/PKCE generation, the short-lived signed state
 * cookie, callback validation, and the whitelist sign-in step both providers
 * share. Provider specifics live in oauth-github.server.ts /
 * oauth-google.server.ts.
 *
 * Whitelist model (Phase 10 wired the 9B org data into it):
 * - A user row with the verified email (any idp) is the base whitelist —
 *   existing accounts keep the exact phase-2 behavior.
 * - Google: an email whose domain is in `google_domain_allowlist` is
 *   provisioned on first sign-in (passwordless row, the allowlist's mapped
 *   role) — audit `auth.oauth.user_provisioned`.
 * - GitHub: a placeholder whitelist row (`github.com/<handle>`, created by
 *   org-settings "Users & access") is CLAIMED on first sign-in — the row
 *   gets the real verified email + display name — audit
 *   `auth.oauth.placeholder_claimed`.
 * - The GitHub login is persisted to users.github_handle at every GitHub
 *   sign-in (9C decision 3 follow-up: attribution no longer email-only).
 * No open self-signup anywhere.
 */

export type OAuthProvider = "github" | "google";

export const OAUTH_COOKIE_NAME = "viberr_oauth";
const OAUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export interface OAuthStatePayload {
  provider: OAuthProvider;
  state: string;
  /** PKCE code verifier (Google; GitHub OAuth apps don't support PKCE). */
  codeVerifier?: string;
  returnTo?: string;
}

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE S256 pair. */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64url");
  return { verifier, challenge };
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}

/** Short-lived signed cookie carrying the OAuth state across the redirect. */
export function serializeOAuthStateCookie(
  payload: OAuthStatePayload,
  secret: string,
  secure: boolean,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return (
    `${OAUTH_COOKIE_NAME}=${encoded}.${hmac(encoded, secret)}; Path=/; ` +
    `Max-Age=${OAUTH_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax` +
    (secure ? "; Secure" : "")
  );
}

export function clearOAuthStateCookie(secure: boolean): string {
  return (
    `${OAUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` +
    (secure ? "; Secure" : "")
  );
}

export function readOAuthStateCookie(
  request: Request,
  secret: string,
): OAuthStatePayload | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  let raw: string | null = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== OAUTH_COOKIE_NAME) continue;
    raw = part.slice(eq + 1).trim();
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // base64url content — raw is fine
    }
    break;
  }
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const encoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = hmac(encoded, secret);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as OAuthStatePayload;
    if (
      (parsed.provider === "github" || parsed.provider === "google") &&
      typeof parsed.state === "string" &&
      parsed.state.length > 0
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export type CallbackValidation =
  | { ok: true; code: string }
  | {
      ok: false;
      reason:
        | "missing_state_cookie"
        | "provider_mismatch"
        | "state_mismatch"
        | "missing_code"
        | "provider_error";
      providerError?: string;
    };

/**
 * Validates the provider redirect against the state cookie. Pure — the
 * route reads the cookie and passes it in.
 */
export function validateOAuthCallback(
  url: URL,
  cookiePayload: OAuthStatePayload | null,
  expectedProvider: OAuthProvider,
): CallbackValidation {
  const providerError = url.searchParams.get("error");
  if (providerError) return { ok: false, reason: "provider_error", providerError };
  if (!cookiePayload) return { ok: false, reason: "missing_state_cookie" };
  if (cookiePayload.provider !== expectedProvider) {
    return { ok: false, reason: "provider_mismatch" };
  }
  const state = url.searchParams.get("state");
  if (!state || state !== cookiePayload.state) {
    return { ok: false, reason: "state_mismatch" };
  }
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, reason: "missing_code" };
  return { ok: true, code };
}

export type OAuthLoginResult =
  | {
      status: "success";
      user: UserRecord;
      session: CreatedSession;
      mustResetPassword: boolean;
    }
  | { status: "not_whitelisted"; email: string }
  | { status: "no_verified_email" }
  | { status: "exchange_failed"; detail: string };

function oauthNotWhitelisted(
  db: Database.Database,
  provider: OAuthProvider,
  email: string,
  reason: "disabled" | "not_whitelisted",
): OAuthLoginResult {
  recordAudit(db, {
    action: "auth.oauth.failure",
    actor: { userId: null, label: email },
    details: { provider, email, reason },
  });
  return { status: "not_whitelisted", email };
}

/** Session + audit + idp sync for an authenticated, whitelisted user. */
function establishOAuthSession(
  db: Database.Database,
  provider: OAuthProvider,
  user: UserRecord,
  meta: SessionMeta,
): OAuthLoginResult {
  if (user.idp !== provider) {
    updateUserFields(db, user.id, { idp: provider });
  }
  recordUserLogin(db, user.id);
  const session = createSession(db, user.id, meta);
  recordAudit(db, {
    action: "auth.oauth.login",
    actor: { userId: user.id, label: user.email },
    subjectKind: "user",
    subjectId: user.id,
    details: { provider },
  });
  return {
    status: "success",
    user: { ...user, idp: provider },
    session,
    mustResetPassword: user.pwresetRequired,
  };
}

/**
 * Whitelist sign-in shared by both providers: the verified provider email
 * must match an existing, non-disabled user row. Updates user.idp on first
 * OAuth login, stamps last_login_at, creates the session, records audit.
 */
export function signInVerifiedOAuthEmail(
  db: Database.Database,
  provider: OAuthProvider,
  email: string,
  meta: SessionMeta = {},
): OAuthLoginResult {
  const user = findUserByEmail(db, email);
  if (!user || user.disabled) {
    return oauthNotWhitelisted(
      db,
      provider,
      email,
      user ? "disabled" : "not_whitelisted",
    );
  }
  return establishOAuthSession(db, provider, user, meta);
}

/**
 * Google sign-in (Phase 10): the account-existence whitelist first (exact
 * phase-2 behavior for existing rows), then the 9B `google_domain_allowlist`
 * — a verified email on an allowlisted domain is provisioned on first login
 * as a passwordless Google account with the domain's mapped role.
 */
export function signInGoogleVerifiedEmail(
  db: Database.Database,
  identity: { email: string; name?: string | null },
  meta: SessionMeta = {},
): OAuthLoginResult {
  const email = normalizeEmail(identity.email);
  const existing = findUserByEmail(db, email);
  if (existing) {
    if (existing.disabled) {
      return oauthNotWhitelisted(db, "google", email, "disabled");
    }
    return establishOAuthSession(db, "google", existing, meta);
  }

  const role = findDomainAllowlistRole(db, email);
  if (!role) return oauthNotWhitelisted(db, "google", email, "not_whitelisted");

  const user = insertUser(db, {
    id: newId("u"),
    email,
    name: identity.name?.trim() || email.split("@")[0] || email,
    role,
    passwordHash: null, // OAuth-only account (the row IS the whitelist)
    idp: "google",
  });
  recordAudit(db, {
    action: "auth.oauth.user_provisioned",
    actor: { userId: user.id, label: user.email },
    subjectKind: "user",
    subjectId: user.id,
    details: { provider: "google", email, role, via: "domain_allowlist" },
  });
  return establishOAuthSession(db, "google", user, meta);
}

/**
 * GitHub sign-in (Phase 10): the account-existence whitelist first, then the
 * 9B github-handle placeholder rows — a whitelisted `@handle` row is claimed
 * on first sign-in (real email + display name replace the placeholders).
 * The GitHub login is persisted to users.github_handle on every path.
 */
export function signInGithubVerifiedIdentity(
  db: Database.Database,
  identity: { email: string; handle: string | null; name?: string | null },
  meta: SessionMeta = {},
): OAuthLoginResult {
  const email = normalizeEmail(identity.email);
  const handle = identity.handle?.trim().replace(/^@/, "") || null;

  const existing = findUserByEmail(db, email);
  if (existing) {
    if (existing.disabled) {
      return oauthNotWhitelisted(db, "github", email, "disabled");
    }
    if (handle && existing.githubHandle !== handle) {
      updateUserFields(db, existing.id, { githubHandle: handle });
    }
    return establishOAuthSession(
      db,
      "github",
      { ...existing, githubHandle: handle ?? existing.githubHandle },
      meta,
    );
  }

  const placeholder = handle
    ? findUserByEmail(db, githubPlaceholderEmail(handle))
    : null;
  if (!placeholder || placeholder.disabled) {
    return oauthNotWhitelisted(db, "github", email, "not_whitelisted");
  }

  // Claim the placeholder: the whitelisted row becomes the real identity.
  db.prepare(
    `UPDATE users SET email = ?, name = ?, github_handle = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    email,
    identity.name?.trim() || placeholder.name,
    handle,
    new Date().toISOString(),
    placeholder.id,
  );
  recordAudit(db, {
    action: "auth.oauth.placeholder_claimed",
    actor: { userId: placeholder.id, label: email },
    subjectKind: "user",
    subjectId: placeholder.id,
    details: { provider: "github", handle, email },
  });
  const claimed = findUserByEmail(db, email);
  if (!claimed) return oauthNotWhitelisted(db, "github", email, "not_whitelisted");
  return establishOAuthSession(db, "github", claimed, meta);
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
