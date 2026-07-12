import { expect, test } from "@playwright/test";

test.use({ storageState: "e2e/.auth/selin.json" });

test("a contributor task owner accepts healthy repository-free completion", async ({
  page,
}) => {
  await page.goto("/projects/e2e-governance/tasks/E2E-1");

  await expect(page.locator(".packet")).toHaveCount(0);
  await expect(page.locator(".op-recs")).toHaveCount(0);
  const acceptance = page.getByRole("region", {
    name: "Completion acceptance",
  });
  await expect(acceptance).toContainText("Ready for acceptance");
  await acceptance.getByRole("button", { name: "Accept completion" }).click();

  await expect(
    page.locator(".toast", {
      hasText: "Completion accepted · E2E-1 moved to Done",
    }),
  ).toBeVisible();
  await expect(acceptance).toHaveCount(0);

  await page.goto("/projects/e2e-governance/board");
  const done = page.locator("section.column", {
    has: page.locator(".col-head", { hasText: "Done" }),
  });
  await expect(done.locator("a.card", { hasText: "E2E-1" })).toBeVisible();
});
