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

  // Operator scheduling stand-in: the operator agent reaction lands on the
  // timeline and flips waiting → agent. Assert the reaction is PRESENT (not
  // strictly newest — the operator may post further reactions on top).
  const reaction = page
    .locator(".tl-item")
    .filter({ hasText: "Acceptance boundary now owned by" });
  await expect(reaction.first()).toBeVisible();
  await expect(reaction.first().getByText("agent", { exact: true })).toBeVisible();
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
  // Find THIS comment by its text (the operator's own reaction comments also
  // appear), then assert it carries the routed tint + @operator mention chip.
  const routed = page
    .locator(".comment-card.toagent")
    .filter({ hasText: "re-run the quality gate" });
  await expect(routed.first()).toBeVisible();
  await expect(routed.first().locator("span.mention")).toHaveText("@operator");
});
