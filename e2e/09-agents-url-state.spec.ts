import { expect, test } from "@playwright/test";

test("Agents URL state survives browser Back and Forward", async ({ page }) => {
  await page.goto(
    "/projects/viberr-core/agents?view=profiles&profile=operator",
  );
  await expect(page.locator(".ag-detail h1")).toHaveText("Operator");

  await page
    .locator(".profile-list .ag-item", { hasText: "Developer" })
    .click();
  await expect(page).toHaveURL(/\?view=profiles&profile=developer$/);
  await expect(page.locator(".ag-detail h1")).toHaveText("Developer");

  await page.getByRole("button", { name: /^Live/ }).click();
  await expect(page).toHaveURL(/\?view=live&profile=developer$/);
  await expect(page.locator(".live-wrap")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\?view=profiles&profile=developer$/);
  await expect(page.locator(".ag-detail h1")).toHaveText("Developer");

  await page.goBack();
  await expect(page).toHaveURL(/\?view=profiles&profile=operator$/);
  await expect(page.locator(".ag-detail h1")).toHaveText("Operator");

  await page.goForward();
  await expect(page).toHaveURL(/\?view=profiles&profile=developer$/);
  await expect(page.locator(".ag-detail h1")).toHaveText("Developer");
});
