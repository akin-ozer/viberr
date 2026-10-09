import { redirect, type MiddlewareFunction } from "react-router";
import { getAuth } from "~/lib/auth.server";
import type {
  ThemePreference,
  UserRecord,
  UserRole,
} from "~/shared/mapping/user.server";
import { getDb } from "../db/sqlite.server";
import { bindCorrelation } from "../logging/request-context.server";
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

interface AuthResolution {
  ctx: AuthContext | null;
  renewalHeaders: Headers;
}

/**
 * Ruling 11 (FL-8 / SRV-7): the session is resolved ONCE per request. React
 * Router hands every loader of one request the same Request object (single
 * fetch runs root, the layout and the leaf with it: react-router router.js
 * `loadRouteData`), and a resource route's guards pass theirs along
 * (`requireUser`, then `requireProjectMember`). Each used to run its own
 * better-auth `getSession` — session and user reads, the provider fingerprint,
 * an HMAC verify — three times per task-page revalidation.
 *
 * Reads only. A POST can change what its own session resolves to (sign-in,
 * sign-out, a password reset), so a mutation resolves on every call as before;
 * the loaders that follow an action get a fresh Request from the router.
 * Sharing also means `sessionRenewalMiddleware` finds the rolling-session
 * renewal cookie (F10-17) whichever loader asked first.
 */
const resolvedByRequest = new WeakMap<Request, Promise<AuthResolution>>();

/**
 * Authenticates a request from its better-auth session AND captures the renewal
 * headers better-auth emits (F10-17).
 *
 * Better Auth is configured for rolling sessions (auth.server.ts: 30-day expiry,
 * 1-day updateAge). When a session is touched past its updateAge, better-auth
 * slides the DB expiry AND emits a fresh session cookie via `Set-Cookie`. The
 * old code called `getSession({ headers })` and read only the session object,
 * DISCARDING that renewal cookie — so the browser cookie could expire at the
 * original login+30d mark regardless of activity, diverging from the DB. Passing
 * `returnHeaders: true` captures the `Set-Cookie` so root's
 * `sessionRenewalMiddleware` can forward it to the browser and the roll
 * actually reaches the client.
 *
 * `renewalHeaders` is a Headers object that carries any `Set-Cookie` the refresh
 * produced (usually empty — most requests are within the updateAge window).
 */
function authenticateWithHeaders(
  request: Request,
): Promise<AuthResolution> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return resolveSession(request);
  }
  let pending = resolvedByRequest.get(request);
  if (!pending) {
    pending = resolveSession(request);
    resolvedByRequest.set(request, pending);
    // A failure is not remembered: the next guard asks again, as before.
    pending.catch(() => resolvedByRequest.delete(request));
  }
  return pending;
}

async function resolveSession(request: Request): Promise<AuthResolution> {
  const { response: result, headers: renewalHeaders } =
    await getAuth().api.getSession({
      headers: request.headers,
      returnHeaders: true,
    });
  if (!result) return { ctx: null, renewalHeaders };
  const db = getDb();
  const user = findUserById(db, result.user.id);
  if (!user || user.disabled) {
    db.prepare(`DELETE FROM session WHERE id = ?`).run(result.session.id);
    return { ctx: null, renewalHeaders };
  }
  // Ruling 43: every later log record of this request names who made it.
  // Every guard resolves the session here, so this is the one place. The user
  // id only: nothing from the session itself (its token is a credential).
  bindCorrelation({ userId: user.id });
  return {
    ctx: {
      user: toSessionUser(user),
      pwresetRequired: user.pwresetRequired,
      sessionId: result.session.id,
      sessionToken: result.session.token,
    },
    renewalHeaders,
  };
}

/**
 * F10-17, ruling 11: forwards the rolling-session renewal onto the response
 * of any GET whose loaders resolved the session, whichever loader asked. The
 * root loader used to forward it, which tied the slide to root running; root
 * no longer re-runs on live events and navigations (RF-7), and a day's one
 * renewal lands on whichever request first asks after it is due, often a
 * layout's `.data`. A POST resolves unshared and forwards nothing here, as
 * before: its own action answers for the cookies it sets (sign-in, sign-out).
 */
export const sessionRenewalMiddleware: MiddlewareFunction<Response> = async (
  { request },
  next,
) => {
  const response = await next();
  const pending = resolvedByRequest.get(request);
  if (!pending) return response;
  let renewal: string[];
  try {
    renewal = (await pending).renewalHeaders.getSetCookie();
  } catch {
    return response;
  }
  if (renewal.length === 0) return response;
  const present = new Set(response.headers.getSetCookie());
  const missing = renewal.filter((cookie) => !present.has(cookie));
  if (missing.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of missing) headers.append("Set-Cookie", cookie);
  // A new Response: a fetched or redirect response's headers are immutable.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * Authenticates a request from its better-auth session. The identity invariant
 * (better-auth `user.id` === `users.id`) lets us load the canonical `users` row
 * for the profile/role. A disabled or vanished user has their better-auth
 * session deleted and is treated as signed out. `sessionId` is better-auth's
 * session id — it keys the double-submit CSRF token. Null when signed out.
 *
 * This drops the renewal headers; {@link sessionRenewalMiddleware} forwards
 * them from the request's shared resolution, so the rolling-session cookie
 * reaches the browser (F10-17). Guards that only need the identity use this.
 */
export async function authenticate(
  request: Request,
): Promise<AuthContext | null> {
  return (await authenticateWithHeaders(request)).ctx;
}

/** Sanitizes a post-login redirect target: same-app absolute paths only. */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  // Judge the string the BROWSER will resolve, not the one we were handed.
  // URL parsing removes tab, newline and carriage return before resolving, so
  // "/<tab>/evil.example" arrives here looking like a local path (it starts
  // with a single "/") and reaches the browser as "//evil.example" — a
  // protocol-relative URL pointing off-site. Strip them first, then check, and
  // return the stripped form so what we hand back is what we validated.
  const resolved = value.replace(/[\t\n\r]/g, "");
  if (!resolved.startsWith("/")) return null;
  if (resolved.startsWith("//") || resolved.startsWith("/\\")) return null;
  return resolved;
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

const ROLE_ORDER = {
  member: 1,
  admin: 2,
} satisfies Record<UserRole, number>;

/** Role hierarchy check: admin > member. */
function roleSatisfies(role: UserRole, required: UserRole): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[required];
}

/** Interface review 2026-09-24 (writ-1): the only gated tier is "admin" (a
 *  member is every signed-in user), so the refusal names it in the product's
 *  term, "org admin", and says who can help. The page error boundary shows
 *  this message verbatim (D32-15). */
function forbiddenRole(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "forbidden",
        message:
          "Only org admins can open this page. Ask an org admin for access.",
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
  if (!roleSatisfies(user.role, required)) throw forbiddenRole();
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
  if (!roleSatisfies(ctx.user.role, required)) throw forbiddenRole();
  return ctx;
}
