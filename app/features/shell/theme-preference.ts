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

/** How long a theme change takes. Exported with no importer on purpose:
 *  exported, the build inlines it at its two uses; module-local, it ships as
 *  a variable, 7 to 11 B more gzip on every route closure the ruling-11
 *  ratchet budgets (measured 2026-10-08). */
export const THEME_FLIP_MS = 250;
/** Every property the tokens paint, on one clock. */
const FLIP_CSS =
  "*,*::before,*::after{transition:" +
  [
    "color",
    "background-color",
    "border-color",
    "outline-color",
    "text-decoration-color",
    "fill",
    "stroke",
    "box-shadow",
  ]
    .map((property) => `${property} ${THEME_FLIP_MS}ms ease`)
    .join(",") +
  "!important}";

let flip: { style: HTMLStyleElement; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * The one writer for `<html data-theme>` after first paint (the boot script
 * in root.tsx owns the first paint and registers no listener).
 *
 * A theme change fades (Apple: never cut between light and dark, an abrupt
 * brightness jump is the one thing to avoid). It fades on ONE clock: the sheet
 * animates colour on ~50 rules at .14s and paints the rest with none, so a
 * flip left alone smeared — every surface crossfaded on its own clock and
 * mid-flip frames painted dark text on dark buttons. For the length of the
 * flip an override gives every element and pseudo-element the same colour
 * transition, so text and the fill under it move together; the override is
 * lifted once they have landed. It is in place when the attribute changes, so
 * the new colours transition from the old ones in the same style pass.
 *
 * Not a view transition: those snapshot the page and swallow every click
 * until they finish (measured 2026-09-24, with `::view-transition` set to
 * `pointer-events: none` too), and the account menu's theme item stays open
 * so a person can click through the three values. Here the page stays live,
 * and a flip made mid-flip turns around from the colours on screen. A
 * same-value write (the root effect re-applying after a revalidation)
 * touches nothing.
 */
export function setDocumentTheme(dark: boolean): void {
  const root = document.documentElement;
  const next = dark ? "dark" : "light";
  if (root.dataset.theme === next) return;
  if (flip) clearTimeout(flip.timer);
  const style = flip?.style ?? document.head.appendChild(document.createElement("style"));
  style.textContent = FLIP_CSS;
  root.dataset.theme = next;
  flip = {
    style,
    timer: setTimeout(() => {
      style.remove();
      flip = null;
    }, THEME_FLIP_MS + 50),
  };
}
