import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "../config/env.server";

/**
 * The `viberr_session` cookie carries the opaque session token as a signed
 * value: `<token>.<base64url HMAC-SHA256(secret, token)>`.
 * httpOnly, SameSite=Lax, Path=/, Secure in production, Max-Age 30 days
 * (re-issued by the root loader whenever the server-side rolling expiry
 * renews, so the cookie slides along with the session).
 */

export const SESSION_COOKIE_NAME = "viberr_session";
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}

/** Pure: cookie value for a session token. Exported for tests. */
export function signSessionValue(token: string, secret: string): string {
  return `${token}.${hmac(token, secret)}`;
}

/** Pure: verifies a cookie value, returning the token or null. */
export function verifySessionValue(
  value: string,
  secret: string,
): string | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const token = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = hmac(token, secret);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.byteLength !== b.byteLength) return null;
  return timingSafeEqual(a, b) ? token : null;
}

function cookieValueFromHeader(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // raw value is fine — token/signature are base64url
    }
    return value;
  }
  return null;
}

/** Pure: reads and verifies the session token from a request. */
export function readSessionTokenWithSecret(
  request: Request,
  secret: string,
): string | null {
  const value = cookieValueFromHeader(request, SESSION_COOKIE_NAME);
  if (!value) return null;
  return verifySessionValue(value, secret);
}

/** Pure: Set-Cookie header value. Exported for tests. */
export function sessionCookieHeaderWithSecret(
  token: string,
  secret: string,
  secure: boolean,
): string {
  return (
    `${SESSION_COOKIE_NAME}=${signSessionValue(token, secret)}; Path=/; ` +
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax` +
    (secure ? "; Secure" : "")
  );
}

/** Pure: Set-Cookie header value that deletes the cookie. */
export function clearSessionCookieHeaderWithSecure(secure: boolean): string {
  return (
    `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` +
    (secure ? "; Secure" : "")
  );
}

// ---- env-aware wrappers (what routes use) ----

function cookieEnv(): { secret: string; secure: boolean } {
  const env = getEnv();
  return {
    secret: env.VIBERR_SESSION_SECRET,
    secure: env.NODE_ENV === "production",
  };
}

/** Reads + verifies the session token from the request cookie. */
export function readSessionToken(request: Request): string | null {
  return readSessionTokenWithSecret(request, cookieEnv().secret);
}

/** Set-Cookie header installing a session token. */
export function sessionCookieHeader(token: string): string {
  const { secret, secure } = cookieEnv();
  return sessionCookieHeaderWithSecret(token, secret, secure);
}

/** Set-Cookie header destroying the session cookie. */
export function clearSessionCookieHeader(): string {
  return clearSessionCookieHeaderWithSecure(cookieEnv().secure);
}
