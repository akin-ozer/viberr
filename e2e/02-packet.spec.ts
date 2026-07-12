import { expect, test } from "@playwright/test";

/**
 * Golden path (b): open VIB-142 → the decision packet renders → resolve
 * with "Request one edit" → packet clears, a decision event lands at the
 * top of the timeline, and the action toast fires.
 */

test("resolving the VIB-142 packet with Request one edit", async ({ page }) => {
  await page.goto("/projects/viberr-core/tasks/VIB-142");

  // The packet renders with its options radiogroup.
  const packet = page.locator(".packet");
  await expect(packet).toBeVisible();
  const option = packet.getByRole("radio", { name: /Request one edit/ });
  await expect(option).toBeVisible();
  await option.click();

  // Resolve with the packet's primary action.
  await packet.locator("button.btn.primary").click();

  // Toast (verbatim §5 copy) …
  await expect(
    page.locator(".toast", { hasText: "Decision recorded: Request one edit" }),
  ).toBeVisible();

  // … the packet is gone …
  await expect(packet).toHaveCount(0);

  // … and the recorded decision lands in the timeline as Arda's event. It need
  // not be the strict newest item: resolving the packet also invokes the
  // operator, which may post its own reaction on top — so assert the decision
  // is PRESENT rather than first (robust to operator follow-ups).
  const decision = page
    .locator(".tl-item")
    .filter({ hasText: /Decision|edit/ })
    .filter({ hasText: "Arda Kaya" });
  await expect(decision.first()).toBeVisible();
});
