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

  // … and the newest timeline event is the recorded decision (transition
  // event written into task.md by resolvePacket).
  const newest = page.locator(".tl-item").first();
  await expect(newest.locator(".tl-text")).toContainText(/Decision|edit/);
  await expect(newest.getByText("Arda Kaya")).toBeVisible();
});
