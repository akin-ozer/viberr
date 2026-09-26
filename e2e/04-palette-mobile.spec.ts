import { expect, test } from "@playwright/test";

/**
 * Pass 15 and 16 UX rulings at phone width, end to end:
 *
 *  - F15-18 — under the mobile breakpoint the workspace rail collapses behind
 *    a toggle instead of holding a 232px column on a 375px screen;
 *  - P16-G3 — a phone keeps a way into the ⌘K palette (R15-5 made the topbar
 *    box the global palette): Home's finder collapses to a trigger, and the
 *    workspace trigger is a finger-sized target.
 */

test("at 375px the rail collapses behind a toggle and nothing scrolls sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/projects/viberr-core/board");

  const rail = page.locator(".rail");
  // Off-canvas: still in the DOM (its counts drive the toggle target) but
  // translated out of the viewport AND visibility:hidden, so its links leave
  // the tab order (interface review 2026-09-24, acce-13).
  await expect(rail).toBeHidden();

  // The page itself must not scroll horizontally — the D-29 "reflow" promise.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // The toggle is a React onClick, and a click can land on server-rendered
  // HTML before hydration and be lost, so retry until it takes — but only
  // click while it is still CLOSED, or the retry toggles it shut again (the
  // .2s slide means the first assertion can read a mid-transition box).
  const toggle = page.getByLabel("Project navigation");
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-expanded", "true", {
      timeout: 1000,
    });
  }).toPass({ timeout: 15_000 });
  await expect(rail).toBeVisible();
  // …and only then assert the slide landed, once the transition settles.
  await expect
    .poll(async () => (await rail.boundingBox())!.x, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(-1);
});

test("at 375px Home keeps a way into the palette (G3)", async ({ page }) => {
  // The finding this pins: below 900px Home used to hide `.top-search`
  // outright, and below 1080px a global rule hid the `.kbd` chip — so a phone
  // lost BOTH the project finder and the only trigger for the palette, while
  // the ⌘K shortcut it replaced them with is not an affordance on a phone.
  // The box now collapses to a magnifier button rather than vanishing.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.waitForURL("/");

  const box = page.locator(".home-top .top-search");
  await expect(box).toBeVisible();

  // Collapsed: the text field is gone (there is no room for it), the trigger
  // is not. Losing the field is fine — the palette searches projects too.
  await expect(box.locator("input")).toBeHidden();

  const trigger = box.getByRole("button", { name: "Search everything" });
  await expect(trigger).toBeVisible();
  // A finger target, not a 12px chip.
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox!.height).toBeGreaterThanOrEqual(30);
  expect(triggerBox!.width).toBeGreaterThanOrEqual(30);

  // Same hydration caveat as the rail toggle: retry the click until the
  // dialog proves it took.
  const palette = page.locator("dialog.cmdk-card");
  await expect(async () => {
    await trigger.click();
    await expect(palette).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  await palette.getByRole("combobox").fill("viberr");
  await expect(palette.locator(".cmdk-row").first()).toBeVisible();
});

test("at 375px the workspace palette trigger is a real touch target (G3)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/projects/viberr-core/board");
  const trigger = page.locator(".topbar > .top-search");
  await expect(trigger).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox!.height).toBeGreaterThanOrEqual(34);
});
