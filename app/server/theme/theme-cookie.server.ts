/**
 * Theme preference cookie (`viberr_theme`): SSR-safe first paint for the
 * light/dark/system theme, mirroring the mock's localStorage prefs.
 * Plain value (no signing/encoding) so a client-side switcher can also
 * write it directly; deliberately NOT HttpOnly for the same reason.
 */

import { z } from "zod";
import { cookieValues } from "../http/cookies.server";

const THEME_COOKIE_NAME = "viberr_theme";

const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** The cookie value and the `theme` form field are both untrusted text; this
 *  is the one decoder both boundaries run before the value is a preference. */
const themePreferenceSchema = z.enum(THEME_PREFERENCES);

export function isThemePreference(value: string): value is ThemePreference {
  return themePreferenceSchema.safeParse(value).success;
}

/** Reads the theme preference from the request's Cookie header. Default: system. */
export function getThemePreference(request: Request): ThemePreference {
  return cookieValues(request, THEME_COOKIE_NAME).find(isThemePreference) ?? "system";
}

/** Set-Cookie value persisting the preference (~400 days, browser max). */
export function serializeThemePreference(theme: ThemePreference): string {
  return `${THEME_COOKIE_NAME}=${theme}; Path=/; Max-Age=${60 * 60 * 24 * 400}; SameSite=Lax`;
}
