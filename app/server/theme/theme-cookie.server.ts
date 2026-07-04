/**
 * Theme preference cookie (`viberr_theme`): SSR-safe first paint for the
 * light/dark/system theme, mirroring the mock's localStorage prefs.
 * Plain value (no signing/encoding) so a client-side switcher can also
 * write it directly; deliberately NOT HttpOnly for the same reason.
 */

export const THEME_COOKIE_NAME = "viberr_theme";

export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === "string" &&
    (THEME_PREFERENCES as readonly string[]).includes(value)
  );
}

/** Reads the theme preference from the request's Cookie header. Default: system. */
export function getThemePreference(request: Request): ThemePreference {
  const header = request.headers.get("Cookie");
  if (!header) return "system";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== THEME_COOKIE_NAME) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep raw value; validated below anyway
    }
    if (isThemePreference(value)) return value;
  }
  return "system";
}

/** Set-Cookie value persisting the preference (~400 days, browser max). */
export function serializeThemePreference(theme: ThemePreference): string {
  return `${THEME_COOKIE_NAME}=${theme}; Path=/; Max-Age=${60 * 60 * 24 * 400}; SameSite=Lax`;
}
