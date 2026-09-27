import { expect, test } from "@playwright/test";

/**
 * Golden path (e): notifications mark-all-read works, the profile theme switch
 * persists across a reload, and the profile shows where to connect an agent
 * account.
 *
 * These assert against SEEDED state. They used to run after the packet and
 * ownership specs and describe themselves in terms of those mutations; those
 * specs went with the simulated runtime, so the narrative is rewritten to say
 * what the seed actually provides. The assertions are unchanged.
 */

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

/**
 * Ruling 127: Profile → Agent accounts. Every agent run bills ONE person's
 * provider account, so a fresh instance must show the signed-in admin exactly
 * where to connect Claude and Codex, and must say honestly that neither is
 * connected yet.
 *
 * Presence only, deliberately: connecting either backend drives the vendor's
 * own binary out to Anthropic or OpenAI, and the e2e image has no network and
 * no account to bill. The sign-in flow itself is covered where it can be driven
 * against a fake vendor binary (backend-login.server.test.ts).
 */
test("profile shows Agent accounts with both backends unconnected", async ({
  page,
}) => {
  await page.goto("/profile");

  const panel = page.locator(".panel", { hasText: "Agent accounts" });
  await expect(panel).toBeVisible();

  const cards = panel.locator(".cred-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator(".cred-name")).toHaveText("Claude");
  await expect(cards.nth(1).locator(".cred-name")).toHaveText("Codex");

  // Both read "not connected" — the badge says it in words (ruling 148) — and
  // each names the vendor whose account a run would bill. Not connected is a
  // fresh account's resting state, so that sentence is the card's quiet note,
  // no longer a "Not connected." warning box (design pass, 2026-09-08).
  for (const [i, label] of [
    [0, "Claude"],
    [1, "Codex"],
  ] as const) {
    await expect(cards.nth(i).locator(".cred-top")).toContainText("not connected");
    await expect(
      cards
        .nth(i)
        .getByText(
          `Tasks you own and your controller conversations run on your own ${label} account.`,
        ),
    ).toBeVisible();
  }

  // The vendors' own flows, not a Viberr-implemented OAuth and never a
  // setup-token field.
  await expect(
    panel.getByRole("button", { name: "Sign in with Claude" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Sign in with ChatGPT" }),
  ).toBeVisible();
  await expect(panel.getByText(/setup.token/i)).toHaveCount(0);

  // The panel sits above GitHub identity in the right column.
  await expect(page.locator(".panel", { hasText: "GitHub identity" })).toBeVisible();
});
