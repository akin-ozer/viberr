import { expect, test } from "@playwright/test";

/**
 * Golden path (e): review queue reflects VIB-142's post-resolution state,
 * the activity feed renders, notifications mark-all-read works, and the
 * profile theme switch persists across a reload.
 */

test("review queue shows VIB-142 with the agents after the request-edit decision", async ({
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

  // Spec 02 resolved VIB-142 with request_edit → waiting flipped to agent,
  // so the row left "Waiting on your acceptance" and sits with the agents.
  await expect(waitingPanel.getByText("VIB-142")).toHaveCount(0);
  await expect(agentsPanel.getByText("VIB-142")).toBeVisible();
});

test("activity feed renders day-grouped events", async ({ page }) => {
  await page.goto("/projects/viberr-core/activity");

  await expect(page.locator(".act-day").first()).toBeVisible();
  // Specs 02/03 wrote governed events today as Arda.
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
