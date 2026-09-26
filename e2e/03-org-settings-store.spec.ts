import { expect, test } from "@playwright/test";

/**
 * Golden path (f): org settings tabs render for an org admin, each settings
 * page names its own scope, and the instance pages sit under the app header.
 */

test("org settings tabs render", async ({ page }) => {
  await page.goto("/org/settings");

  // Connections tab (default).
  await expect(page.getByText("GitHub connections").first()).toBeVisible();

  await page.goto("/org/settings?tab=users");
  await expect(page.getByText("Users & access").first()).toBeVisible();
  await expect(page.getByText("arda@viberr.dev").first()).toBeVisible();

  await page.goto("/org/settings?tab=resources");
  await expect(page.getByText("Agent resources").first()).toBeVisible();
});

/**
 * R15-13. Instance settings used to be titled "Viberr settings", which collides
 * with a project literally named Viberr — and the project's own settings page
 * was titled just "Settings". The surface that was NOT about that project
 * carried its name; the one that WAS did not. Asserted live against both real
 * pages because the collision only exists between them.
 */
test("settings headings name their own scope (R15-13)", async ({ page }) => {
  await page.goto("/org/settings");
  const orgH1 = page.locator("h1");
  await expect(orgH1).toHaveCount(1);
  await expect(orgH1).toHaveText("Instance settings");

  // The project's settings page names the project in its own heading.
  await page.goto("/projects/viberr-core/settings");
  const projH1 = page.locator("h1");
  await expect(projH1).toHaveCount(1);
  await expect(projH1).toContainText("· settings");
  await expect(projH1).toContainText("Viberr Core");
});

/**
 * Ruling 145. The instance surfaces behind Home's Settings tiles rendered with
 * no app header at all: no brand, no search, no bell, no account menu, and an
 * in-page back button doing the navigating. Checked live on both of them, since
 * the whole point is that a person walking from a board into settings finds the
 * same header there.
 */
test("the instance pages sit under the app header (ruling 145)", async ({ page }) => {
  for (const [path, crumb] of [
    ["/org/settings", "Instance settings"],
    ["/insights", "Insights"],
  ]) {
    await page.goto(path!);
    const header = page.locator("header.home-top");
    await expect(header).toBeVisible();
    await expect(header.locator(".home-brand")).toHaveAttribute("href", "/");
    await expect(header.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
      crumb!,
    );
    // The four parts the workspace topbar carries, in the same order.
    await expect(
      header.getByLabel("Search tasks, epics, branches, agents, projects"),
    ).toBeVisible();
    await expect(header.getByLabel("Notifications")).toBeVisible();
    await expect(header.getByLabel("Account menu")).toBeVisible();
    // And nothing left over: the in-page back buttons these pages used to
    // carry are gone, so the header is the only way out.
    await expect(page.locator("main").getByRole("link", { name: "Home" })).toHaveCount(0);

    // The page under it still fills the shell. The header made these pages flex
    // ITEMS, and a flex item with an auto cross-axis margin loses the default
    // stretch — Insights shrank to its content until `.insights` declared a
    // width, which no unit test can see.
    const box = (await page.locator("main").boundingBox())!;
    expect(box.width).toBeGreaterThan(1000);
  }
});
