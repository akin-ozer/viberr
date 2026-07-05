import { expect, test } from "@playwright/test";

/**
 * Golden path (d): VIB-151 has seeded RUNNING specialist runs → the live
 * run strip renders, the agent logs panel streams at least one NEW line
 * over SSE (seed-resumer drip), and the raw toggle switches the console
 * to wire-format JSON.
 */

test("VIB-151 live run strip and streaming agent logs", async ({ page }) => {
  await page.goto("/projects/viberr-core/tasks/VIB-151");

  // Live run strip (only rendered while runs are in state=running).
  await expect(page.locator(".runbar")).toBeVisible();

  // Agent logs console with seeded lines.
  const console_ = page.locator(".console");
  await expect(console_).toBeVisible();
  const lines = console_.locator(".log-line");
  const before = await lines.count();
  expect(before).toBeGreaterThan(0);

  // The seeded running runs drip live lines over SSE — wait for at least
  // one NEW line to arrive.
  await expect(async () => {
    expect(await lines.count()).toBeGreaterThan(before);
  }).toPass({ timeout: 30_000 });

  // Raw mode shows the persisted wire envelopes (JSON) for every line.
  const rawToggle = page.locator("button", { hasText: "raw" }).first();
  await rawToggle.click();
  await expect(console_.getByText(/"type"\s*:/).first()).toBeVisible();
});
