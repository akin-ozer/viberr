import { expect, test } from "@playwright/test";

/**
 * Golden path (e): the review queue partitions correctly, the activity feed
 * renders, notifications mark-all-read works, and the profile theme switch
 * persists across a reload.
 *
 * These assert against SEEDED state. They used to run after the packet and
 * ownership specs and describe themselves in terms of those mutations; those
 * specs went with the simulated runtime, so the narrative is rewritten to say
 * what the seed actually provides. The assertions are unchanged.
 */

test("review queue lists VIB-142 with the agents, not awaiting acceptance", async ({
  page,
}) => {
  await page.goto("/projects/viberr-core/review");

  const waitingPanel = page.locator(".panel", {
    hasText: "Waiting on your acceptance",
  });
  // R8-3: the working panel was renamed "Still with agents" → "Still in review"
  // (it now holds agent-side tasks AND human-waiting tasks not in this viewer's set).
  const agentsPanel = page.locator(".panel", { hasText: "Still in review" });
  await expect(waitingPanel).toBeVisible();
  await expect(agentsPanel).toBeVisible();

  // VIB-142 seeds as waiting on the agent side, so it sits in the agents
  // panel and must NOT appear under "Waiting on your acceptance".
  await expect(waitingPanel.getByText("VIB-142")).toHaveCount(0);
  await expect(agentsPanel.getByText("VIB-142")).toBeVisible();
});

/**
 * R15-11. The queue's whole job is deciding, yet its rows were unlabeled
 * clickable regions with no named action. Asserted against a rendered queue
 * that actually has rows, because "the row names its action" is a claim about
 * what a reader sees, not about a component's props.
 */
test("review queue rows name their primary action (R15-11)", async ({ page }) => {
  await page.goto("/projects/viberr-core/review");
  const rows = page.locator(".rq-row");
  await expect(rows.first()).toBeVisible();

  const go = rows.first().locator(".rq-go");
  await expect(go).toHaveText(/Review/);
  // Decorative for assistive tech — the row's own aria-label already names the
  // target, so the label must not be announced twice.
  await expect(go).toHaveAttribute("aria-hidden", "true");
  await expect(rows.first()).toHaveAttribute("aria-label", /^Review VIB-\d+: /);

  // Never "Accept": acceptance is verdict-gated (R15-1) and can refuse, and this
  // surface does not evaluate that gate — naming it would promise an outcome it
  // cannot deliver.
  await expect(go).not.toHaveText(/Accept/);

  // And it still navigates to the task, where the evidence and the decision are.
  await rows.first().click();
  await page.waitForURL("**/projects/viberr-core/tasks/**");
});

test("activity feed renders day-grouped events", async ({ page }) => {
  await page.goto("/projects/viberr-core/activity");

  await expect(page.locator(".act-day").first()).toBeVisible();
  // The seed writes governed events attributed to Arda.
  await expect(page.getByText("Arda Kaya").first()).toBeVisible();
});

test("notifications mark-all-read clears every unread row", async ({
  page,
}) => {
  await page.goto("/notifications");

  // Seeded inbox has unread rows for Arda.
  await expect(page.locator(".unread-dot.in").first()).toBeVisible();

  await page.locator("button", { hasText: "Mark all read" }).click();

  await expect(page.locator(".unread-dot.in")).toHaveCount(0);
});

test("profile theme switch persists after reload", async ({ page }) => {
  await page.goto("/profile");

  // The theme control is the first .mini-seg (Light / Dark / System).
  const themeSeg = page.locator(".mini-seg").first();
  const darkBtn = themeSeg.getByRole("button", { name: "Dark", exact: true });

  // Retry click+assert so the overlay route's hydration can't drop the click.
  await expect(async () => {
    await darkBtn.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  }).toPass({ timeout: 10_000 });

  // The instant apply is client-only; wait for the /prefs/theme POST to
  // persist the cookie before reloading so SSR paints dark.
  await expect
    .poll(
      async () =>
        (await page.context().cookies()).find(
          (c) => c.name === "viberr_theme",
        )?.value,
      { timeout: 10_000 },
    )
    .toBe("dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Restore the default so later manual runs start from system.
  await themeSeg.getByRole("button", { name: "System", exact: true }).click();
});
