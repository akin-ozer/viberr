import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";

test.use({ storageState: "e2e/.auth/selin.json" });

test("accepted repository work stays in Review until its PR is really merged", async ({
  page,
}) => {
  await page.goto("/projects/e2e-governance/tasks/E2E-2");

  const validation = page.getByRole("region", { name: "Human validation" });
  await validation.getByRole("button", { name: "Record validation" }).click();
  await expect(
    page.locator(".toast", {
      hasText: "Validation recorded · E2E-2 is ready for separate acceptance",
    }),
  ).toBeVisible();
  await expect(validation).toHaveCount(0);

  const packet = page.locator(".packet");
  await packet.getByRole("radio", { name: /Accept completion/ }).click();
  await packet.getByRole("button", { name: "Accept completion" }).click();

  await expect(
    page.locator(".toast", {
      hasText:
        "Completion accepted · E2E-2 stays in Review until its PR is merged",
    }),
  ).toBeVisible();
  await expect(page.getByText("PR #999002 · merge pending")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Complete merge" }),
  ).toBeVisible();

  await page.goto("/projects/e2e-governance/board");
  const review = page.locator("section.column", {
    has: page.locator(".col-head", { hasText: "Review" }),
  });
  const done = page.locator("section.column", {
    has: page.locator(".col-head", { hasText: "Done" }),
  });
  await expect(review.locator("a.card", { hasText: "E2E-2" })).toBeVisible();
  await expect(done.locator("a.card", { hasText: "E2E-2" })).toHaveCount(0);
});

test("a contributor owner finalizes accepted work after an exact external merge", async ({
  page,
}) => {
  await page.goto("/projects/e2e-governance/tasks/E2E-3");

  await expect(page.getByText("PR #999003 · merge pending")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Completion acceptance" }),
  ).toHaveCount(0);
  const complete = page.getByRole("button", { name: "Complete merge" });
  await expect(complete).toHaveAttribute(
    "title",
    "Run the real GitHub merge for this accepted PR (needs a valid project credential)",
  );

  // Simulate a GitHub-side merge after Viberr recorded acceptance. The
  // preloaded transport will now report this exact repo/base/head as merged;
  // its PUT path is deliberately a hard failure, proving no repeat PUT occurs.
  writeFileSync(
    new URL(".github-fixture-pr-999003-merged", import.meta.url),
    "merged\n",
  );
  await complete.click();

  await expect(
    page.locator(".toast", {
      hasText: "PR #999003 merged · E2E-3 moved to Done.",
    }),
  ).toBeVisible();
  const currentState = page.locator(".panel", {
    has: page.getByRole("heading", { name: "Current state" }),
  });
  await expect(currentState).toContainText("Done");
  await expect(complete).toHaveCount(0);

  await page.goto("/projects/e2e-governance/board");
  const done = page.locator("section.column", {
    has: page.locator(".col-head", { hasText: "Done" }),
  });
  await expect(done.locator("a.card", { hasText: "E2E-3" })).toBeVisible();
});
