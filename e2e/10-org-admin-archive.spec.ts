import { expect, test } from "@playwright/test";

test("an organization admin can archive a foreign project read-only and restore it", async ({
  page,
}) => {
  // Arda is intentionally absent from this fixture project's member list.
  await page.goto("/projects/e2e-governance/settings");
  await expect(page.getByText(/org admin override/i)).toBeVisible();

  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(
    page.locator(".toast", { hasText: "archived read-only" }),
  ).toBeVisible();
  await expect(page.getByText("Archived · read-only").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore", exact: true }),
  ).toBeVisible();

  await page.goto("/projects/e2e-governance/board");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Archived · read-only history" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toHaveCount(0);
  await expect(page.getByLabel("New task in this stage")).toHaveCount(0);

  await page.goto("/projects/e2e-governance/settings");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.locator(".toast", { hasText: 'Project "E2E Governance" restored' }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeVisible();

  await page.goto("/projects/e2e-governance/board");
  await expect(page.getByText("Archived · read-only history")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New task", exact: true }),
  ).toBeVisible();
});
