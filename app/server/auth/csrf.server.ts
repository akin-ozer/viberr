import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "../config/env.server";

/**
 * CSRF protection for mutating actions:
 * 1. Origin / Sec-Fetch-Site checking (browser-enforced request metadata).
 * 2. A double-submit token tied to the session: HMAC(secret, session id),
 *    injected into forms via <CsrfInput /> (app/ui/csrf-input.tsx, fed by
 *    the root loader) as hidden field "_csrf".
 *
 * The login action has no session yet — it uses assertTrustedOrigin() only
 * (plus rate limiting). Everything else calls assertCsrf(request, sessionId).
 */

export const CSRF_FIELD_NAME = "_csrf";

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
 * Origin / Sec-Fetch-Site check for mutating requests. Same-origin form
 * posts pass; cross-site browser requests fail. Requests without either
 * header (curl, server-to-server) pass — the token check is the backstop
 * for cookie-bearing browser requests.
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
  const origin = request.headers.get("Origin");
  if (origin && origin !== "null") {
    let requestOrigin: string;
    try {
      requestOrigin = new URL(request.url).origin;
    } catch {
      throw forbidden("Request origin could not be determined.");
    }
    if (origin !== requestOrigin) {
      throw forbidden("Cross-origin request rejected.");
    }
  } else if (origin === "null") {
    throw forbidden("Opaque-origin request rejected.");
  }
}

/** Pure core so tests can pass an explicit secret. */
export async function assertCsrfWithSecret(
  request: Request,
  sessionId: string,
  secret: string,
  formData?: FormData,
): Promise<void> {
  assertTrustedOrigin(request);

  let provided: string | null = null;
  const headerToken = request.headers.get("X-Csrf-Token");
  if (headerToken) {
    provided = headerToken;
  } else {
    const form = formData ?? (await request.clone().formData());
    const field = form.get(CSRF_FIELD_NAME);
    provided = typeof field === "string" ? field : null;
  }
  if (!provided) throw forbidden("Missing CSRF token.");

  const expected = csrfTokenForSession(sessionId, secret);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    throw forbidden("Invalid CSRF token.");
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
  await assertCsrfWithSecret(
    request,
    sessionId,
    getEnv().VIBERR_SESSION_SECRET,
    formData,
  );
}
