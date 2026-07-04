import type Database from "better-sqlite3";
import { redirect } from "react-router";
import type { ThemePreference, UserRole } from "~/shared/mapping/user.server";
import { getEnv } from "../config/env.server";
import { getDb } from "../db/sqlite.server";
import { readSessionTokenWithSecret } from "./session-cookie.server";
import { getSessionByToken } from "./session.server";
import { findUserById } from "./user-store.server";

/**
 * Request authentication + RBAC guards for loaders and actions.
 *
 * - requireUser(request)             → SessionUser or redirect to /login
 * - requireRole(request, "admin")    → SessionUser or 403 (role hierarchy)
 * - requireAuth(request)             → full AuthContext (session id/token)
 * - authenticate(request)            → AuthContext | null (root loader)
 *
 * Forced password reset: while user.pwreset_required is set, requireUser
 * redirects everything to /login (which renders the set-new-password step)
 * — pass allowPendingPasswordReset for the few places that must still work
 * (the reset action itself, logout).
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  title: string | null;
  role: UserRole;
  theme: ThemePreference;
  idp: string;
  /** Avatar tone class ("" | "rose" | "teal" | "violet") — phase-4 shell. */
  avatarTone: string;
}

export interface AuthContext {
  user: SessionUser;
  /** Forced password reset pending — gate all routes until cleared. */
  pwresetRequired: boolean;
  /** sessions.id (sha256 of the token) — safe to log, keys the CSRF token. */
  sessionId: string;
  /** Raw session token — only for cookie re-issue / logout. Never log. */
  sessionToken: string;
  /** True when the rolling expiry renewed → re-issue the cookie. */
  sessionRenewed: boolean;
}

/** Core with explicit db+secret (tests). Deletes sessions of disabled users. */
export function authenticateRequest(
  db: Database.Database,
  request: Request,
  secret: string,
): AuthContext | null {
  const token = readSessionTokenWithSecret(request, secret);
  if (!token) return null;
  const found = getSessionByToken(db, token);
  if (!found) return null;
  const user = findUserById(db, found.session.userId);
  if (!user || user.disabled) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(found.session.id);
    return null;
  }
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      title: user.title,
      role: user.role,
      theme: user.theme,
      idp: user.idp,
      avatarTone: user.avatarTone ?? "",
    },
    pwresetRequired: user.pwresetRequired,
    sessionId: found.session.id,
    sessionToken: token,
    sessionRenewed: found.renewed,
  };
}

/** Authenticates a request against the app db. Null when not signed in. */
export function authenticate(request: Request): AuthContext | null {
  return authenticateRequest(getDb(), request, getEnv().VIBERR_SESSION_SECRET);
}

/** Sanitizes a post-login redirect target: same-app absolute paths only. */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  return value;
}

function loginRedirect(request: Request): Response {
  const url = new URL(request.url);
  const returnTo = url.pathname + url.search;
  const target =
    returnTo && returnTo !== "/"
      ? `/login?returnTo=${encodeURIComponent(returnTo)}`
      : "/login";
  return redirect(target);
}

export interface RequireUserOptions {
  /** Let a user with a pending forced password reset through (login/logout). */
  allowPendingPasswordReset?: boolean;
}

/** Full auth context or redirect to /login (throws). */
export function requireAuth(
  request: Request,
  options: RequireUserOptions = {},
): AuthContext {
  const ctx = authenticate(request);
  if (!ctx) throw loginRedirect(request);
  if (ctx.pwresetRequired && !options.allowPendingPasswordReset) {
    throw loginRedirect(request);
  }
  return ctx;
}

/** The signed-in user or redirect to /login (throws). */
export function requireUser(
  request: Request,
  options: RequireUserOptions = {},
): SessionUser {
  return requireAuth(request, options).user;
}

const ROLE_ORDER: Record<UserRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
};

/** Role hierarchy check: admin > member > viewer. */
export function roleSatisfies(role: UserRole, required: UserRole): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[required];
}

/** Signed-in user with at least `required` role, else 403 (throws). */
export function requireRole(request: Request, required: UserRole): SessionUser {
  const user = requireUser(request);
  if (!roleSatisfies(user.role, required)) {
    throw new Response(
      JSON.stringify({
        error: {
          code: "forbidden",
          message: `This area requires the ${required} role.`,
        },
      }),
      {
        status: 403,
        statusText: "Forbidden",
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return user;
}
