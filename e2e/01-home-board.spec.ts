import { expect, test } from "@playwright/test";

/**
 * Golden path (a): login (via stored session) → Home renders the three
 * seeded projects → open the viberr-core board → stage columns render
 * with the VIB-142 card in Review.
 */

test("home renders the three seeded projects", async ({ page }) => {
  await page.goto("/");

  const cards = page.locator(".pj-card, .pj-row");
  await expect(cards).toHaveCount(3);
  await expect(page.getByText("Viberr Core").first()).toBeVisible();
});

test("viberr-core board renders stage columns and the VIB-142 card", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator('a[href="/projects/viberr-core/board"]')
    .first()
    .click();
  await page.waitForURL("**/projects/viberr-core/board");

  // Five seeded stages, one column each.
  const columns = page.locator("section.column");
  await expect(columns).toHaveCount(5);
  for (const stage of ["Triage", "Ready", "In Progress", "Review", "Done"]) {
    await expect(
      page.locator("section.column .col-head").getByText(stage, { exact: true }),
    ).toBeVisible();
  }

  // VIB-142 card is on the board and links to the task workspace.
  const card = page.locator("a.card", { hasText: "VIB-142" });
  await expect(card).toBeVisible();
  await card.click();
  await page.waitForURL("**/projects/viberr-core/tasks/VIB-142");
  await expect(page.getByText("VIB-142").first()).toBeVisible();
});
