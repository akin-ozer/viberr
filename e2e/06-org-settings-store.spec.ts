import { expect, test } from "@playwright/test";

/**
 * Golden path (f): org settings tabs render for an org admin, and the
 * StoreBrowser performs a REAL file-store mutation (new folder) through
 * the UI.
 */

test("org settings tabs render", async ({ page }) => {
  await page.goto("/org/settings");

  // Connections tab (default).
  await expect(page.getByText("GitHub connections").first()).toBeVisible();

  await page.goto("/org/settings?tab=users");
  await expect(page.getByText("Users & access").first()).toBeVisible();
  await expect(page.getByText("arda@viberr.dev").first()).toBeVisible();

  await page.goto("/org/settings?tab=resources");
  await expect(page.getByText("Agent resources").first()).toBeVisible();
});

test("StoreBrowser creates a folder through the UI", async ({ page }) => {
  await page.goto("/org/settings?tab=resources");

  // Open the file browser on the first knowledge base (the trigger is an
  // icon button labelled "Browse files in <name>", not visible text).
  await page.locator('[aria-label^="Browse files"]').first().click();
  const browser = page.locator(".modal-card");
  await expect(browser).toBeVisible();

  await browser.locator("button", { hasText: "New folder" }).first().click();
  const input = browser.getByLabel(/New folder/i).first();
  await input.fill("e2e-golden-path");
  await input.press("Enter");

  // The created folder appears in the TREE (a real fs mkdir + rescan). Scoped to
  // `.fm-name` because P14-KM-08 added a destination picker whose `<option>` for
  // the same folder matches a bare text lookup first — and an `<option>` is never
  // "visible", so the unscoped assertion failed on a feature that works.
  await expect(browser.locator(".fm-name", { hasText: "e2e-golden-path" }).first()).toBeVisible();
});
