import type { ThemePreference } from "~/server/theme/theme-cookie.server";

/** Applies the preference to <html data-theme> immediately (personal UI
 * state — optimistic apply is sanctioned; the cookie/user row follow). */
export function applyThemePreference(theme: ThemePreference): void {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
