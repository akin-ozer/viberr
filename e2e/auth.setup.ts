import { expect, test as setup, type Page } from "@playwright/test";

const ARDA_STATE = "e2e/.auth/arda.json";
const SELIN_STATE = "e2e/.auth/selin.json";

/**
 * Logs in through the real /login UI (CSRF token + session cookie) and
 * saves the storage state every golden-path spec reuses.
 */
async function signIn(
  page: Page,
  email: string,
  statePath: string,
): Promise<void> {
  await page.goto("/login");
  // The inputs are React-controlled: a fill that lands before hydration is
  // wiped when React takes over. Wait for the module graph to settle, then
  // retry the whole login until the redirect proves the submit carried.
  await page.waitForLoadState("networkidle");
  await expect(async () => {
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "viberr-dev-2828");
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });

  // Successful login lands on Home.
  await expect(page.locator(".pj-card, .pj-row").first()).toBeVisible();

  await page.context().storageState({ path: statePath });
}

setup("sign in as arda", async ({ page }) => {
  await signIn(page, "arda@viberr.dev", ARDA_STATE);
});

setup("sign in as selin", async ({ page }) => {
  await signIn(page, "selin@viberr.dev", SELIN_STATE);
});
