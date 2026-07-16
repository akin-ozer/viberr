import { expect, test } from "@playwright/test";

/**
 * Golden path (d): the runtime UI on a seeded task.
 *
 * Under R6-5 (demo-run honesty), seeded "running" runs are RETIRED to finished
 * at boot — they no longer masquerade as live (no phantom run strip, no SSE
 * drip of demo lines). So this path now validates the DURABLE runtime surface:
 * the agent-logs console renders the run's persisted lines, the raw toggle
 * switches to wire-format JSON, and — the R6-5 assertion — a finished seeded run
 * shows NO live run strip. The live-strip-while-running behavior itself is
 * covered by the LiveRunPanel component tests (runs-panels.test.tsx).
 */

test("VIB-151 agent logs render + raw toggle; no phantom live strip (R6-5)", async ({ page }) => {
  await page.goto("/projects/viberr-core/tasks/VIB-151");

  // Agent logs console with the seeded run's persisted lines.
  const console_ = page.locator(".console");
  await expect(console_).toBeVisible();
  const lines = console_.locator(".log-line");
  await expect(async () => {
    expect(await lines.count()).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });

  // R6-5: the seeded run is finished demo history — no zombie live run strip.
  await expect(page.locator(".runbar")).toHaveCount(0);

  // Raw mode shows the persisted wire envelopes (JSON) for every line.
  const rawToggle = page.locator("button", { hasText: "raw" }).first();
  await rawToggle.click();
  await expect(console_.getByText(/"type"\s*:/).first()).toBeVisible();
});
