// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyThemePreference, setDocumentTheme } from "./theme-preference";

/**
 * Interface review 2026-09-06: the sheet animates colour on ~50 rules at .14s,
 * so a theme flip smeared — mid-flip frames measured dark text on dark
 * buttons. The swap now runs under a `transition: none` override that lives
 * for exactly one forced style recalc.
 */
describe("setDocumentTheme", () => {
  const originalMatchMedia = window.matchMedia;
  afterEach(() => {
    document.head.querySelectorAll("style").forEach((s) => s.remove());
    delete document.documentElement.dataset.theme;
    vi.restoreAllMocks();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  /** Records what the document looked like at the moment of the forced recalc. */
  function watchRecalc() {
    const seen: string[] = [];
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        const override = document.head.querySelector("style");
        seen.push(
          `${document.documentElement.dataset.theme}:${
            override?.textContent?.includes("transition:none") ? "override" : "none"
          }`,
        );
        return 0;
      },
    );
    return seen;
  }

  it("commits the new theme under the override, then lifts it", () => {
    document.documentElement.dataset.theme = "light";
    const seen = watchRecalc();
    setDocumentTheme(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    // The recalc ran with the new attribute AND the override in place — the
    // ordering that keeps every colour transition from starting.
    expect(seen).toEqual(["dark:override"]);
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("does nothing on a same-value write (a revalidation re-applying the pref)", () => {
    document.documentElement.dataset.theme = "dark";
    const seen = watchRecalc();
    setDocumentTheme(true);
    expect(seen).toEqual([]);
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("leaves no override behind across rapid flips", () => {
    document.documentElement.dataset.theme = "light";
    const seen = watchRecalc();
    setDocumentTheme(true);
    setDocumentTheme(false);
    setDocumentTheme(true);
    expect(seen).toEqual(["dark:override", "light:override", "dark:override"]);
    expect(document.head.querySelectorAll("style")).toHaveLength(0);
    expect(document.documentElement.dataset.theme).toBe("dark");
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
