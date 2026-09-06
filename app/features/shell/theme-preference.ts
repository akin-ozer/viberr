import type { ThemePreference } from "~/server/theme/theme-cookie.server";

/** Applies the preference to <html data-theme> immediately (personal UI
 * state — optimistic apply is sanctioned; the cookie/user row follow). */
export function applyThemePreference(theme: ThemePreference): void {
  setDocumentTheme(
    theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
}

/**
 * The one writer for `<html data-theme>` after first paint (the boot script
 * in root.tsx owns the first paint and registers no listener).
 *
 * The sheet animates background, colour and border-colour on ~50 rules at
 * .14s, so a theme flip used to smear: every surface crossfaded on its own
 * clock and mid-flip frames painted dark text on dark buttons. The swap now
 * happens under a `transition: none` override that lives for exactly one
 * style recalc: the attribute changes, the forced recalc commits the new
 * colours with transitions disabled (a transition only starts when a value
 * changes while transitions are enabled), and the override is removed. A
 * same-value write (the root effect re-applying after a revalidation) touches
 * nothing.
 */
export function setDocumentTheme(dark: boolean): void {
  const root = document.documentElement;
  const next = dark ? "dark" : "light";
  if (root.dataset.theme === next) return;
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(style);
  root.dataset.theme = next;
  // The forced recalc is the load-bearing line: without it the override would
  // be gone before any style pass saw the new colours. Reading layout is the
  // deliberate cost of one flip.
  void root.offsetHeight;
  style.remove();
}
