import { expect, test } from "@playwright/test";

/**
 * Golden path (d): the runtime UI, from an honestly-empty store to a live run.
 *
 * Under R7-2 (don't simulate at all) the demo seed ships ZERO fabricated run
 * history, so a fresh task renders NO runtime panels at all — no phantom run
 * strip, no scripted console history. This path then starts a run through the
 * product's own "Run" affordance (carried by the deterministic test engine —
 * the e2e server opens the R7-2 gate via VIBERR_FORCE_SIMULATED_RUNTIME +
 * VIBERR_TEST_RUNTIME_OK) and validates the durable runtime surface: the
 * console streams persisted lines and the raw toggle switches to wire-format
 * JSON.
 */

test("VIB-151: no fabricated seed runs; Run streams a run; raw toggle", async ({ page }) => {
  await page.goto("/projects/viberr-core/tasks/VIB-151");

  // R7-2: the seed fabricates NO run history — the runtime panels are
  // entirely absent (the layout suppresses them for a task with no threads).
  await expect(page.locator(".panel-head", { hasText: "Execution profile" })).toBeVisible();
  await expect(page.locator(".console")).toHaveCount(0);
  await expect(page.locator(".runbar")).toHaveCount(0);

  // Start a run for the assigned specialist through the product control.
  // Exact "Run" excludes "Run operator"; the first match is the primary
  // specialist's (the engaged reviewer's Run button follows it).
  const runButton = page.getByRole("button", { name: "Run", exact: true }).first();
  await expect(runButton).toBeEnabled();
  await runButton.click();

  // The run streams into the agent-logs console (persisted lines over SSE).
  const console_ = page.locator(".console");
  await expect(console_).toBeVisible({ timeout: 15_000 });
  const lines = console_.locator(".log-line");
  await expect(async () => {
    expect(await lines.count()).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });

  // Raw mode shows the persisted wire envelopes (JSON) for every line.
  const rawToggle = page.locator("button", { hasText: "raw" }).first();
  await rawToggle.click();
  await expect(console_.getByText(/"type"\s*:/).first()).toBeVisible();
});
