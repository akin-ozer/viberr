import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { appOrigin, getEnv } from "../config/env.server";

/**
 * CSRF protection for mutating actions:
 * 1. Origin / Sec-Fetch-Site / Referer checking (browser-enforced request
 *    metadata) — a request that proves nothing about where it came from is
 *    refused, see assertTrustedOrigin. It is the app's one origin check:
 *    React Router's own is switched off in react-router.config.ts, because
 *    behind the TLS proxy it cannot see the public scheme (ruling 683).
 * 2. A double-submit token tied to the session: HMAC(secret, session id),
 *    injected into forms via <CsrfInput /> (app/ui/csrf-input.tsx, fed by
 *    the root loader) as hidden field "_csrf".
 *
 * The login action has no session yet — it uses assertTrustedOrigin() only
 * (plus rate limiting). Everything else calls assertCsrf(request, sessionId).
 */

const CSRF_FIELD_NAME = "_csrf";

/** A submitted token is a non-empty string; a file part, a missing field or an
 *  empty value all mean "no token was sent" and are refused as such. */
const csrfFieldSchema = z.string().min(1);

/** The session's token, HMAC(session secret, session id): the same on every
 *  call for one session (the root loader's `<CsrfInput />` and `assertCsrf`). */
export function getCsrfToken(sessionId: string): string {
  return createHmac("sha256", getEnv().VIBERR_SESSION_SECRET)
    .update(`viberr-csrf:${sessionId}`, "utf8")
    .digest("base64url");
}

function forbidden(reason: string): Response {
  return new Response(
    JSON.stringify({ error: { code: "forbidden", message: reason } }),
    {
      status: 403,
      statusText: "Forbidden",
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * The deployment's public origin, parsed from `BETTER_AUTH_URL`, or null when
 * it is unset. Its `origin` is the scheme, host and port a browser serialises
 * in `Origin`. better-auth builds its OAuth callbacks from the same value.
 */
function configuredOrigin(): URL | null {
  const configured = appOrigin();
  if (!configured) return null;
  try {
    return new URL(configured);
  } catch {
    return null;
  }
}

/**
 * The origin people reach this deployment on: the configured public origin,
 * else the origin the request arrived on. The Sign-in & SSO card shows the
 * OAuth callback under it and the credential probe sends that callback, so
 * both match the callback better-auth sends (ruling 683).
 */
export function publicOrigin(request: Request): string {
  return configuredOrigin()?.origin ?? new URL(request.url).origin;
}

/**
 * Origin check for mutating requests: the request must PROVE it came from this
 * deployment. Every signal it carries (`Sec-Fetch-Site`, `Origin`, `Referer`)
 * has to say same-origin, and it has to carry at least one of them.
 *
 * Two origins count as this deployment's (ruling 683): the request's own, and
 * the configured public origin (`BETTER_AUTH_URL`). Behind the TLS-terminating
 * proxy deployment.md requires, react-router-serve builds `request.url` from
 * the plain-HTTP socket, so the request's own origin is `http://` while the
 * browser sends `Origin: https://…`; the configured origin is the one the
 * browser actually used. The request's own origin still counts when the app
 * is reached under another name, such as the upstream port on loopback.
 *
 * It does not count when it is the configured https host over plain http.
 * With the proxy forwarding `Host`, that is what the request's own origin
 * reads, but no page a person uses lives there: only the proxy's port-80
 * listener, or a page a network attacker injects before HSTS applies. Session
 * cookies are `Secure` and better-auth refuses a sign-in from it anyway, so
 * refusing it here costs nothing.
 *
 * `X-Forwarded-Proto` and `X-Forwarded-Host` are never read: any client can
 * send them, and the operator already states the public origin. With
 * `BETTER_AUTH_URL` unset only the request's own origin counts, and the scheme
 * is compared like the rest of the origin, never just the host.
 *
 * §7.10 / A7: the last clause is the fix. A request with none of the three used
 * to PASS — documented as a concession to curl and server-to-server callers,
 * with the double-submit token as the sole backstop. Nothing in the app is such
 * a caller (every `assertTrustedOrigin` site is a browser form surface: the
 * login action and, via `assertCsrf`, `requireFormAction`), so the concession
 * bought nothing and turned a defense-in-depth layer into a header any attacker
 * can simply omit. Browsers send `Origin` on every cross-origin POST and
 * `Sec-Fetch-Site` on every fetch — a genuine same-origin form post always
 * carries at least one, so failing closed costs the app nothing.
 */
export function assertTrustedOrigin(request: Request): void {
  const secFetchSite = request.headers.get("Sec-Fetch-Site");
  if (
    secFetchSite &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "none"
  ) {
    throw forbidden("Cross-site request rejected.");
  }
  let own: URL;
  try {
    own = new URL(request.url);
  } catch {
    throw forbidden("Request origin could not be determined.");
  }
  const configured = configuredOrigin();
  const accepted = new Set<string>();
  if (configured) accepted.add(configured.origin);
  const downgraded =
    configured?.protocol === "https:" &&
    own.protocol === "http:" &&
    own.hostname === configured.hostname;
  if (!downgraded) accepted.add(own.origin);
  const origin = request.headers.get("Origin");
  if (origin === "null") throw forbidden("Opaque-origin request rejected.");
  if (origin && !accepted.has(origin)) {
    throw forbidden("Cross-origin request rejected.");
  }
  // `Referer` is the fallback signal, not a substitute: a referrer policy can
  // strip it, so it is only ever read when it is actually present.
  const referer = request.headers.get("Referer");
  if (referer) {
    let refererOrigin: string | null = null;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      refererOrigin = null;
    }
    if (refererOrigin === null || !accepted.has(refererOrigin)) {
      throw forbidden("Cross-origin request rejected.");
    }
  }
  if (!secFetchSite && !origin && !referer) {
    throw forbidden("Request origin could not be verified.");
  }
}

/**
 * Guard for every mutating action of an authenticated user. Pass the
 * already-parsed formData when you have it (a request body can only be
 * read once without cloning).
 */
export async function assertCsrf(
  request: Request,
  sessionId: string,
  formData?: FormData,
): Promise<void> {
  assertTrustedOrigin(request);

  let provided: string | null = null;
  const headerToken = request.headers.get("X-Csrf-Token");
  if (headerToken) {
    provided = headerToken;
  } else {
    const form = formData ?? (await request.clone().formData());
    const field = csrfFieldSchema.safeParse(form.get(CSRF_FIELD_NAME));
    provided = field.success ? field.data : null;
  }
  if (!provided) throw forbidden("Missing CSRF token.");

  const expected = getCsrfToken(sessionId);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    throw forbidden("Invalid CSRF token.");
  }
}
