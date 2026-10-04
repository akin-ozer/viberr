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
 * Scope was originally the surfaces the PRD calls core workflows, in BOTH
 * themes — light is where the contrast failures lived, and it is the theme the
 * browser pane never showed. Rule set is the wcag2a/wcag2aa/wcag22aa tags only:
 * axe's best-practice rules are opinions, and failing CI on an opinion trains
 * people to ignore the gate.
 *
 * UI-C (inventory rough edge #18) widened it. The sweep audited six surfaces
 * and never once opened a dialog, so the two densest forms in the product (the
 * create-profile modal and org settings) and every page-as-popup route were
 * outside the gate — which is exactly the shape of the R15-12 failure the
 * `agents` entry below was added to close. Every workspace view, both overlay
 * routes, org settings and three dialogs IN THEIR OPEN STATE are audited now.
 */

const THEME_COOKIE = "viberr_theme";

const SURFACES: { name: string; path: string; ready: string }[] = [
  { name: "board", path: "/projects/viberr-core/board", ready: "section.column" },
  // Ruling 503: the Epics page, as a new project sees it (the seed holds no
  // epic). `09-epics.spec.ts` audits an epic's page and its dialogs once it
  // has made one.
  { name: "epics", path: "/projects/viberr-core/epics", ready: ".empty-hero" },
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
  // The six surfaces below were the remainder of the workspace: every one of
  // them ships interactive controls (feed pagination, stage drag handles, the
  // credential card, the org resource editors, the preference toggles, the
  // mark-read buttons) that no automated gate had ever looked at.
  {
    name: "activity",
    path: "/projects/viberr-core/activity",
    ready: ".activity-cols",
  },
  {
    name: "project settings",
    path: "/projects/viberr-core/settings",
    ready: ".policy-cols",
  },
  {
    name: "github",
    path: "/projects/viberr-core/github",
    ready: ".policy-cols",
  },
  { name: "org settings", path: "/org/settings", ready: ".set-layout" },
  // Ruling 653: the board file's drop and the Export list.
  { name: "org settings · import & export", path: "/org/settings?tab=boards", ready: ".board-drop" },
  // Page-as-popup routes: both render their whole page inside a modal
  // <dialog>, so they are also the only two places the sweep sees the
  // top-layer/inert interaction between the overlay and the toast host.
  { name: "profile", path: "/profile", ready: "dialog.page-overlay[open]" },
  {
    name: "notifications",
    path: "/notifications",
    ready: "dialog.page-overlay[open]",
  },
];

/**
 * Dialogs, audited OPEN. A dialog is where the app puts its densest forms and
 * its only `role="alertdialog"` copy, and none of it renders until something is
 * clicked — so "the page has no violations" said nothing about any of it.
 */
const DIALOGS: {
  name: string;
  path: string;
  ready: string;
  open: (page: Page) => Promise<void>;
  dialog: string;
}[] = [
  {
    // Note honestly what this does and does not gate: axe 4.12 does NOT flag
    // the pre-UI-C palette (verified in-browser — `aria-required-children`
    // descends through role-less wrappers, and a missing `role="combobox"` /
    // `aria-activedescendant` is a behavioural gap no rule can see). The
    // combobox contract is gated by `command-palette.test.tsx`; this entry is
    // here so the palette's CONTRAST, name-role-value and focus order are
    // audited in both themes at all — with results on screen, which is the
    // only state most of its markup exists in.
    name: "command palette",
    path: "/projects/viberr-core/board",
    ready: "section.column",
    dialog: "dialog.cmdk-card",
    async open(page) {
      await page.keyboard.press("ControlOrMeta+k");
      await page.locator("dialog.cmdk-card input").fill("vib");
      await page.locator('dialog.cmdk-card [role="option"]').first().waitFor();
    },
  },
  {
    name: "new task",
    path: "/projects/viberr-core/board",
    ready: "section.column",
    dialog: 'dialog.modal-card[aria-label="New task"]',
    async open(page) {
      await page.getByRole("button", { name: "New task", exact: true }).click();
    },
  },
  {
    // The densest form in the product (create AND edit in one 1015-line
    // modal): backend pickers, capability matrices, resource grants.
    name: "create profile",
    path: "/projects/viberr-core/agents",
    ready: "main",
    // D-pass20: the create/edit modal's aria-label is "New agent profile" (the
    // "specialist" wording moved to the button's own copy). The opener button is
    // "New profile".
    dialog: 'dialog[aria-label="New agent profile"]',
    async open(page) {
      await page.getByRole("button", { name: "New profile" }).click();
    },
  },
  {
    // Ruling 121 (review G2). The dock is the app's newest role="dialog" — a
    // composer, a threads list, four icon buttons, a scope pill, a status row
    // and 110 lines of new CSS — and only its CLOSED trigger rode along on the
    // page sweep above. It is NON-modal, so it is queried by its screen label
    // rather than a <dialog> element.
    name: "controller dock",
    path: "/projects/viberr-core/board",
    ready: "section.column",
    dialog: '[data-screen-label="Controller dock"]',
    async open(page) {
      const trigger = page.getByRole("button", { name: /^Controller · / });
      await expect(async () => {
        if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
        await expect(page.locator('[data-screen-label="Controller dock"]')).toBeVisible({
          timeout: 1000,
        });
      }).toPass({ timeout: 15_000 });
    },
  },
];

/** axe samples computed colours, so never audit a mid-animation frame. */
async function settle(page: Page, selector: string) {
  await page
    .locator(selector)
    .evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
}

function report(results: { violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"] }) {
  // Name the offending selectors in the failure message — a bare count sends
  // the next person back to the browser to find them again.
  return results.violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes
          .map((n) => n.target.join(" "))
          .join("\n    ")}`,
    )
    .join("\n  ");
}

async function setTheme(page: Page, theme: "light" | "dark") {
  // Scope the cookie to wherever the page actually is — cookies are
  // host-scoped, and the production compose stack serves on 127.0.0.1 with a
  // derived port, so a hard-coded host would silently never apply.
  await page.context().addCookies([
    { name: THEME_COOKIE, value: theme, url: new URL(page.url()).origin },
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
        expect(report(results), `${surface.name} · ${theme}`).toBe("");
      });
    }

    for (const dialog of DIALOGS) {
      test(`${dialog.name} dialog has no WCAG 2.2 AA violations`, async ({
        page,
      }) => {
        await page.goto("/");
        await setTheme(page, theme);
        await page.goto(dialog.path);
        await expect(page.locator(dialog.ready).first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

        await dialog.open(page);
        await expect(page.locator(dialog.dialog)).toBeVisible();
        await settle(page, dialog.dialog);

        const results = await audit(page).analyze();
        expect(report(results), `${dialog.name} dialog · ${theme}`).toBe("");
      });
    }
  });
}

/**
 * UI-C (inventory rough edge #15) — the mobile rail overlay's dismiss layer was
 * a `<button aria-hidden="true" tabIndex={-1}>`. It passed axe only because the
 * two attributes happened to agree; changing either one silently produced an
 * `aria-hidden-focus` violation, and there was no keyboard dismissal at all
 * beyond re-pressing the toggle. The scrim is decorative now and Escape is the
 * keyboard half.
 */
test.describe("mobile rail overlay", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("dismisses without a hidden interactive scrim", async ({ page }) => {
    await page.goto("/projects/viberr-core/board");
    const toggle = page.getByRole("button", { name: "Project navigation" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Interface review 2026-09-06: the drawer takes focus and the page behind
    // it is inert (Chromium enforces inert; jsdom does not, so this is the
    // one place the after-close focus ordering is really proven).
    await expect(page.locator("nav.rail")).toBeFocused();
    await expect(page.locator("main.main")).toHaveAttribute("inert", "");
    const openResults = await audit(page).analyze();
    expect(report(openResults), "mobile rail overlay (open)").toBe("");

    const scrim = page.locator(".rail-scrim");
    await expect(scrim).toBeVisible();
    // Decorative: not a control, and nothing assistive tech can reach.
    expect(await scrim.evaluate((el) => el.tagName)).toBe("DIV");
    await expect(scrim).toHaveAttribute("aria-hidden", "true");
    expect(await scrim.evaluate((el) => el.hasAttribute("tabindex"))).toBe(false);

    // Escape closes the overlay AND hands focus back to the control that
    // opened it — a scrim could never do either. Move focus INTO the rail
    // first, so "focus is on the toggle" cannot pass by accident.
    await page.locator(".rail .nav-item").first().focus();
    await expect(toggle).not.toBeFocused();
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("main.main")).not.toHaveAttribute("inert", "");
    await expect(toggle).toBeFocused();

    const results = await audit(page).analyze();
    expect(report(results), "mobile rail overlay").toBe("");
  });
});

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
      // The login card plays an entry animation, and beside it the pitch
      // staggers in over about .6s (ruling 459); axe samples computed colors,
      // so let every animation on the page settle instead of auditing a
      // mid-fade frame.
      await settle(page, ".login-wrap");

      const results = await audit(page).analyze();
      expect(report(results), `login · ${theme}`).toBe("");
    });
  }
});
