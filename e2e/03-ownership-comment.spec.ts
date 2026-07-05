import { expect, test } from "@playwright/test";

/**
 * Golden path (c): take ownership of VIB-148 (quality-gated, unowned) →
 * the operator reaction event appears on the timeline; then comment with
 * @operator → the comment is routed (toagent tint + mention chip + toast).
 */

test("taking ownership of VIB-148 triggers the operator reaction", async ({
  page,
}) => {
  await page.goto("/projects/viberr-core/tasks/VIB-148");

  // Unowned task → the owner control offers "Assign me".
  await page.locator("button", { hasText: "Assign me" }).first().click();

  await expect(
    page.locator(".toast", { hasText: "You own VIB-148" }),
  ).toBeVisible();

  // Operator scheduling stand-in: the operator agent event lands on top of
  // the timeline (above the assign event) and flips waiting → agent.
  const newest = page.locator(".tl-item").first();
  await expect(newest.locator(".tl-text")).toContainText(
    "Acceptance boundary now owned by",
  );
  await expect(newest.getByText("agent", { exact: true })).toBeVisible();
});

test("commenting with @operator routes the comment", async ({ page }) => {
  await page.goto("/projects/viberr-core/tasks/VIB-148");

  const composer = page.locator("textarea").first();
  await composer.fill(
    "@operator please re-run the quality gate after the edit lands.",
  );
  // Exact name — "Comment" (submit) must not match the "Comments" filter tab.
  await page.getByRole("button", { name: "Comment", exact: true }).click();

  // Assert on the durable routed comment card (the success toast is transient).
  // toagent tint on the card + the @operator mention chip.
  const routed = page.locator(".comment-card.toagent").first();
  await expect(routed).toBeVisible();
  await expect(routed.locator("span.mention")).toHaveText("@operator");
});
