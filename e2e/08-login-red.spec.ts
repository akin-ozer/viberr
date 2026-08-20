import { expect, test } from "@playwright/test";

/**
 * VIB-1 evidence: capture the signed-out login surface after making the
 * client-side required-email error visible, so every login text treatment is
 * represented in the committed screenshot.
 */
test.describe("signed out login", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("renders its visible text in red", async ({ page }, testInfo) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to Viberr" })).toBeVisible();

    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Enter your email.");

    for (const selector of [
      ".login-brand h1",
      ".login-brand .sub",
      ".login-form .flabel",
      ".login-tag",
      ".login-err",
    ]) {
      await expect(page.locator(selector).first()).toHaveCSS("color", "rgb(96, 0, 0)");
    }

    await page.screenshot({ path: testInfo.outputPath("login-red.png"), fullPage: true });
  });
});
