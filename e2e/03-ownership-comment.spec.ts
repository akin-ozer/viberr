import { expect, test } from "@playwright/test";

/**
 * Golden path (c): take ownership of VIB-148 (quality-gated, unowned) →
 * ownership is recorded with NO operator side effect (F19: taking ownership is a
 * clean ownership mutation — it does not schedule or invoke the operator); then
 * comment with @operator → the comment is routed (toagent tint + mention chip +
 * toast).
 */

test("taking ownership of VIB-148 records ownership with no operator reaction", async ({
  page,
}) => {
  await page.goto("/projects/viberr-core/tasks/VIB-148");

  // Unowned task → the owner control offers "Assign me".
  await page.locator("button", { hasText: "Assign me" }).first().click();

  await expect(
    page.locator(".toast", { hasText: "You own VIB-148" }),
  ).toBeVisible();

  // F19: ownership is recorded as a plain timeline event; the task stays
  // human-waiting and NO operator reaction ("Acceptance boundary now owned by")
  // is scheduled — that side effect was intentionally removed.
  const ownershipEvent = page
    .locator(".tl-item")
    .filter({ hasText: "Took task ownership" });
  await expect(ownershipEvent.first()).toBeVisible();
  await expect(
    page.locator(".tl-item").filter({ hasText: "Acceptance boundary now owned by" }),
  ).toHaveCount(0);
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
