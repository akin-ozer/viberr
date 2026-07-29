import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * WCAG 2.2 AA gate for the core workflows (P13-D-12).
 *
 * `prd.md` promises "Core workflows meet a WCAG 2.2 AA baseline in V1, with
 * light and dark mode", and the profile page asserts it to the user — but the
 * repo shipped no axe, pa11y or Lighthouse dependency and no conformance
 * record, so the claim had never been checked. The intent audit resolved the
 * question against the app by hand (two text tokens below 4.5:1 in light), and
 * pass 13 had already found four more AA defects by reading. A claim this
 * specific needs a gate, not another manual read.
 *
 * Scope is deliberately the five surfaces the PRD calls core workflows, in
 * BOTH themes — light is where the contrast failures lived, and it is the
 * theme the browser pane never showed. Rule set is the wcag2a/wcag2aa/wcag22aa
 * tags only: axe's best-practice rules are opinions, and failing CI on an
 * opinion trains people to ignore the gate.
 */

const THEME_COOKIE = "viberr_theme";

const SURFACES: { name: string; path: string; ready: string }[] = [
  { name: "board", path: "/projects/viberr-core/board", ready: "section.column" },
  {
    name: "task detail",
    path: "/projects/viberr-core/tasks/VIB-142",
    ready: ".detail",
  },
  { name: "review queue", path: "/projects/viberr-core/review", ready: "main" },
  { name: "policy", path: "/projects/viberr-core/policy", ready: "main" },
  { name: "home", path: "/", ready: ".pj-card, .pj-row" },
  // R15-12 added a native <details> to the capability panel, and this surface
  // was outside the sweep — a new interactive control shipped unaudited. It is
  // also the app's densest policy page, which is where a contrast or
  // name-role-value slip is most costly.
  { name: "agents", path: "/projects/viberr-core/agents", ready: "main" },
];

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.context().addCookies([
    {
      name: THEME_COOKIE,
      value: theme,
      url: `http://localhost:${new URL(page.url() || "http://localhost:5177").port || 5177}`,
    },
  ]);
}

function audit(page: Page) {
  return new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag22aa",
  ]);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    for (const surface of SURFACES) {
      test(`${surface.name} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await page.goto("/");
        await setTheme(page, theme);
        await page.goto(surface.path);
        await expect(page.locator(surface.ready).first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

        const results = await audit(page).analyze();

        // Name the offending selectors in the failure message — a bare count
        // sends the next person back to the browser to find them again.
        const detail = results.violations
          .map(
            (v) =>
              `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes
                .map((n) => n.target.join(" "))
                .join("\n    ")}`,
          )
          .join("\n  ");
        expect(detail, `${surface.name} · ${theme}`).toBe("");
      });
    }
  });
}

/**
 * The login page is the one core surface a signed-out user sees, so it is
 * audited without the stored session.
 */
test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const theme of ["light", "dark"] as const) {
    test(`login has no WCAG 2.2 AA violations (${theme})`, async ({ page }) => {
      await page.goto("/login");
      await setTheme(page, theme);
      await page.reload();
      await expect(page.locator('input[name="email"]')).toBeVisible();

      const results = await audit(page).analyze();
      const detail = results.violations
        .map((v) => `${v.id} (${v.impact}): ${v.help}`)
        .join("\n  ");
      expect(detail, `login · ${theme}`).toBe("");
    });
  }
});
