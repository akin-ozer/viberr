import { expect, test as setup } from "@playwright/test";
import { SEED_DEFAULT_PASSWORD } from "../app/server/seed/seed-credentials";

const ARDA_STATE = "e2e/.auth/arda.json";

/**
 * Logs in through the real /login UI (CSRF token + session cookie) and
 * saves the storage state every golden-path spec reuses.
 */
setup("sign in as arda", async ({ page }) => {
  await page.goto("/login");
  // The inputs are React-controlled: a fill that lands before hydration is
  // wiped when React takes over. Wait for the module graph to settle, then
  // retry the whole login until the redirect proves the submit carried.
  await page.waitForLoadState("networkidle");
  await expect(async () => {
    await page.fill('input[name="email"]', "arda@viberr.dev");
    await page.fill('input[name="password"]', SEED_DEFAULT_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });

  // Successful login lands on Home.
  await expect(page.locator(".pj-card, .pj-row").first()).toBeVisible();

  await page.context().storageState({ path: ARDA_STATE });
});
