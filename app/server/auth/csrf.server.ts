import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getEnv } from "../config/env.server";

/**
 * CSRF protection for mutating actions:
 * 1. Origin / Sec-Fetch-Site / Referer checking (browser-enforced request
 *    metadata) — a request that proves nothing about where it came from is
 *    refused, see assertTrustedOrigin.
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

/** Pure token derivation — deterministic per session. Exported for tests. */
export function csrfTokenForSession(sessionId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`viberr-csrf:${sessionId}`, "utf8")
    .digest("base64url");
}

/** Token for the current session (env wrapper — routes/root loader). */
export function getCsrfToken(sessionId: string): string {
  return csrfTokenForSession(sessionId, getEnv().VIBERR_SESSION_SECRET);
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
 * Origin check for mutating requests: the request must PROVE it came from this
 * origin. Every signal it carries (`Sec-Fetch-Site`, `Origin`, `Referer`) has to
 * say same-origin, and it has to carry at least one of them.
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
  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    throw forbidden("Request origin could not be determined.");
  }
  const origin = request.headers.get("Origin");
  if (origin === "null") throw forbidden("Opaque-origin request rejected.");
  if (origin && origin !== requestOrigin) {
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
    if (refererOrigin !== requestOrigin) {
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
