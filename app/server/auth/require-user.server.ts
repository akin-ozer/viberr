import { redirect } from "react-router";
import { getAuth } from "~/lib/auth.server";
import type {
  ThemePreference,
  UserRecord,
  UserRole,
} from "~/shared/mapping/user.server";
import { getDb } from "../db/sqlite.server";
import { resolveOrgRole } from "./identity.server";
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
  /** better-auth session id — safe to log, keys the CSRF token. */
  sessionId: string;
  /** better-auth session token — logout only. Never log. */
  sessionToken: string;
}

/** Shapes a `users` record into the SessionUser the app consumes. */
function toSessionUser(user: UserRecord): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    title: user.title,
    role: user.role,
    theme: user.theme,
    idp: user.idp,
    avatarTone: user.avatarTone ?? "",
  };
}

/**
 * Authenticates a request from its better-auth session. The identity invariant
 * (better-auth `user.id` === `users.id`) lets us load the canonical `users` row
 * for the profile/role. A disabled or vanished user has their better-auth
 * session deleted and is treated as signed out. `sessionId` is better-auth's
 * session id — it keys the double-submit CSRF token. Null when signed out.
 */
export async function authenticate(
  request: Request,
): Promise<AuthContext | null> {
  const result = await getAuth().api.getSession({ headers: request.headers });
  if (!result) return null;
  const db = getDb();
  const user = findUserById(db, result.user.id);
  if (!user || user.disabled) {
    db.prepare(`DELETE FROM session WHERE id = ?`).run(result.session.id);
    return null;
  }
  // Option-B cutover (pass-4 ruling 5): the org role is authoritatively the
  // better-auth membership, not the legacy `users.role` column (which is now a
  // derived cache kept in sync on every role write).
  const orgRole = resolveOrgRole(db, user.id, user.role);
  return {
    user: toSessionUser({ ...user, role: orgRole }),
    pwresetRequired: user.pwresetRequired,
    sessionId: result.session.id,
    sessionToken: result.session.token,
  };
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
  // React Router 8 always hands loaders the RAW request, so on single-fetch
  // client navigations the URL is the ".data" wire address
  // ("/board.data?_routes=..."), not a navigable app path. Mirror the
  // framework's own getNormalizedPath (react-router lib/server-runtime/urls.ts)
  // so returnTo never sends a re-authenticated user to a .data URL.
  let pathname = url.pathname;
  if (pathname.endsWith("/_.data")) pathname = pathname.replace(/_\.data$/, "");
  else pathname = pathname.replace(/\.data$/, "");
  url.searchParams.delete("_routes");
  const search = url.searchParams.toString();
  const returnTo = pathname + (search ? `?${search}` : "");
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
export async function requireAuth(
  request: Request,
  options: RequireUserOptions = {},
): Promise<AuthContext> {
  const ctx = await authenticate(request);
  if (!ctx) throw loginRedirect(request);
  if (ctx.pwresetRequired && !options.allowPendingPasswordReset) {
    throw loginRedirect(request);
  }
  return ctx;
}

/** The signed-in user or redirect to /login (throws). */
export async function requireUser(
  request: Request,
  options: RequireUserOptions = {},
): Promise<SessionUser> {
  return (await requireAuth(request, options)).user;
}

const ROLE_ORDER: Record<UserRole, number> = {
  member: 1,
  admin: 2,
};

/** Role hierarchy check: admin > member. */
export function roleSatisfies(role: UserRole, required: UserRole): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[required];
}

function forbiddenRole(required: UserRole): Response {
  return new Response(
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

/** Signed-in user with at least `required` role, else 403 (throws). */
export async function requireRole(
  request: Request,
  required: UserRole,
): Promise<SessionUser> {
  const user = await requireUser(request);
  if (!roleSatisfies(user.role, required)) throw forbiddenRole(required);
  return user;
}

/**
 * Like `requireRole` but returns the FULL auth context (user + sessionId) in a
 * single `authenticate()` call — a mutation action needs the session id for the
 * CSRF check, so this avoids the double session lookup (WI-12).
 */
export async function requireRoleAuth(
  request: Request,
  required: UserRole,
): Promise<AuthContext> {
  const ctx = await requireAuth(request);
  if (!roleSatisfies(ctx.user.role, required)) throw forbiddenRole(required);
  return ctx;
}
