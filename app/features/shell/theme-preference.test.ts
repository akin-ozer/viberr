// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyThemePreference, setDocumentTheme, THEME_FLIP_MS } from "./theme-preference";

/**
 * Interface review 2026-09-06: the sheet animates colour on ~50 rules at .14s
 * and paints the rest with none, so a theme flip smeared — mid-flip frames
 * measured dark text on dark buttons. It then swapped under `transition: none`,
 * a hard cut. Apple design pass 2026-09-24: the flip fades, on ONE clock — an
 * override gives every element the same colour transition for the flip's
 * length, so text and its fill move together, and lifts once they land.
 */
describe("setDocumentTheme", () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    document.head.querySelectorAll("style").forEach((s) => s.remove());
    delete document.documentElement.dataset.theme;
    vi.restoreAllMocks();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  const overrides = () => [...document.head.querySelectorAll("style")];

  it("changes the theme under one colour clock for everything, then lifts it", () => {
    document.documentElement.dataset.theme = "light";
    setDocumentTheme(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    // CANARY: back to `transition:none` and this fails — a hard cut.
    const [style, ...extra] = overrides();
    expect(extra).toEqual([]);
    const css = style!.textContent ?? "";
    expect(css.startsWith("*,*::before,*::after{transition:")).toBe(true);
    expect(css.endsWith("!important}")).toBe(true);
    for (const property of ["color", "background-color", "border-color", "fill", "stroke", "box-shadow"]) {
      expect(css).toContain(`${property} ${THEME_FLIP_MS}ms ease`);
    }
    // Colour only: nothing moves while the page changes colour.
    expect(css).not.toMatch(/transform|opacity|\ball\b/);
    vi.advanceTimersByTime(THEME_FLIP_MS);
    expect(overrides()).toHaveLength(1);
    vi.advanceTimersByTime(50);
    expect(overrides()).toHaveLength(0);
  });

  it("does nothing on a same-value write (a revalidation re-applying the pref)", () => {
    document.documentElement.dataset.theme = "dark";
    setDocumentTheme(true);
    expect(overrides()).toHaveLength(0);
  });

  it("turns a flip made mid-flip around under the same override, and lifts it once", () => {
    document.documentElement.dataset.theme = "light";
    setDocumentTheme(true);
    vi.advanceTimersByTime(THEME_FLIP_MS - 50);
    setDocumentTheme(false);
    vi.advanceTimersByTime(THEME_FLIP_MS - 50);
    setDocumentTheme(true);
    // Still one override: the clock restarted with each flip.
    expect(overrides()).toHaveLength(1);
    expect(document.documentElement.dataset.theme).toBe("dark");
    vi.advanceTimersByTime(THEME_FLIP_MS + 50);
    expect(overrides()).toHaveLength(0);
  });

  it("applyThemePreference resolves 'system' through the OS preference", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    document.documentElement.dataset.theme = "light";
    applyThemePreference("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyThemePreference("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
