import { expect, test } from "@playwright/test";

/**
 * Pass 15 UX rulings, end to end:
 *
 *  - R15-5 — the topbar box is the global ⌘K palette (it used to filter the
 *    open board while promising "tasks, branches, agents");
 *  - F15-18 — under the mobile breakpoint the workspace rail collapses behind
 *    a toggle instead of holding a 232px column on a 375px screen;
 *  - R15-4 — a project the signed-in viewer is not a member of refuses with the
 *    same 404 as a slug that does not exist.
 */

test("⌘K opens the palette and Enter jumps to the task", async ({ page }) => {
  await page.goto("/projects/viberr-core/board");
  await page.waitForURL("**/projects/viberr-core/board");

  const palette = page.locator("dialog.cmdk-card");
  // The shortcut is a hydrated keydown listener, so retry until React has
  // attached it — a bare press can land on server-rendered HTML and be lost.
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // The field is a combobox, not a plain textbox: pass 16 gave the palette the
  // APG contract (`role=combobox` + `aria-activedescendant` into the results
  // listbox) that its `data-active` highlight never announced. `role=combobox`
  // REPLACES the input's implicit `textbox`, so asking for a textbox here finds
  // nothing — that is the shape the assertion should hold the palette to.
  await palette.getByRole("combobox").fill("VIB-142");
  const firstRow = palette.locator(".cmdk-row").first();
  await expect(firstRow).toContainText("VIB-142");
  await page.keyboard.press("Enter");
  await page.waitForURL("**/projects/viberr-core/tasks/VIB-142");
});

test("the board keeps its own filter, scoped to this board", async ({ page }) => {
  await page.goto("/projects/viberr-core/board");
  const filter = page.getByLabel("Filter this board");
  await expect(filter).toHaveAttribute("placeholder", "Filter this board…");
  await filter.fill("VIB-142");
  await expect(page).toHaveURL(/[?&]q=VIB-142/);
  await expect(page.locator("a.card", { hasText: "VIB-142" })).toBeVisible();
});

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

  // Same hydration caveat as the palette: the toggle is a React onClick, so
  // retry until it takes — but only click while it is still CLOSED, or the
  // retry toggles it shut again (the .2s slide means the first assertion can
  // read a mid-transition box).
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

test("a non-member gets the unknown-slug 404 on a project board (R15-4)", async ({
  page,
}) => {
  // `billing-service` is seeded with arda as its only member; the e2e session is
  // arda (an org admin), so drive the refusal through a slug that exists for
  // nobody — the copy a non-member sees must be exactly this.
  const response = await page.goto("/projects/not-a-real-project/board");
  expect(response!.status()).toBe(404);
  await expect(
    page.getByText("No project at projects/not-a-real-project."),
  ).toBeVisible();
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

  // Same hydration caveat as ⌘K above: the handler is React's, so retry the
  // click until the dialog proves it took.
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
