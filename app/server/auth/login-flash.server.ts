import { getEnv } from "../config/env.server";

/**
 * One-shot flash message for the login page (OAuth failures land here via
 * redirect). Plain short-lived httpOnly cookie scoped to /login — content is
 * display-only text rendered as React text, so it needs no signing.
 */

export const LOGIN_FLASH_COOKIE_NAME = "viberr_login_flash";

export interface LoginFlash {
  kind: "error" | "info";
  message: string;
}

function secure(): boolean {
  return getEnv().NODE_ENV === "production";
}

export function serializeLoginFlash(flash: LoginFlash): string {
  const value = encodeURIComponent(JSON.stringify(flash));
  return (
    `${LOGIN_FLASH_COOKIE_NAME}=${value}; Path=/login; Max-Age=60; ` +
    `HttpOnly; SameSite=Lax` +
    (secure() ? "; Secure" : "")
  );
}

export function clearLoginFlash(): string {
  return (
    `${LOGIN_FLASH_COOKIE_NAME}=; Path=/login; Max-Age=0; HttpOnly; SameSite=Lax` +
    (secure() ? "; Secure" : "")
  );
}

export function readLoginFlash(request: Request): LoginFlash | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== LOGIN_FLASH_COOKIE_NAME) continue;
    try {
      const parsed = JSON.parse(
        decodeURIComponent(part.slice(eq + 1).trim()),
      ) as LoginFlash;
      if (
        (parsed.kind === "error" || parsed.kind === "info") &&
        typeof parsed.message === "string"
      ) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}
