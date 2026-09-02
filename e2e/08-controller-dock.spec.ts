import { expect, test } from "@playwright/test";

/**
 * Ruling 121 — the controller dock, end to end on the production image:
 *
 *  - the trigger names the place the person is standing (the board, then the
 *    task) and opens a non-modal panel whose context line says what the
 *    controller knows there;
 *  - the composer takes focus on open; Escape closes and hands focus back;
 *  - the two full controller pages carry no dock;
 *  - under the rail's breakpoint the panel is a bottom sheet and nothing
 *    scrolls sideways.
 */

// One spelling: the trigger is named from the workspace loader's project name,
// before the first open as well as after it (review finding 17).
const TRIGGER = "Controller · Viberr Core";
const TASK_TRIGGER = "Controller · VIB-142 · Viberr Core";

test("the dock follows the place you stand, and stays off the controller pages", async ({ page }) => {
  await page.goto("/projects/viberr-core/board");
  const trigger = page.getByRole("button", { name: TRIGGER });
  await expect(trigger).toBeVisible();
  const panel = page.getByRole("dialog", { name: "Controller dock" });
  // The trigger is a hydrated onClick: retry until React has attached it.
  await expect(async () => {
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    await expect(panel).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(panel).toHaveAttribute("aria-modal", "false");
  await expect(page.getByText(/Knows the Viberr Core board/)).toBeVisible();
  // Focus moves INTO the dialog on open: the composer when it can take it, the
  // panel itself when it cannot (this stack has no Claude credential, so the
  // composer is disabled and says so).
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.closest('[data-screen-label="Controller dock"]') !== null,
      ),
    )
    .toBe(true);
  // The page underneath stays LIVE, proven by driving it: `toBeEnabled` reads
  // one attribute and would pass through a scrim, a focus trap or a scroll lock
  // (review finding 31). A click carries an actionability check, so a covering
  // layer fails it; typing then proves focus really reached the page.
  const filter = page.getByLabel("Filter this board");
  await filter.click();
  await filter.fill("VIB-142");
  await expect(filter).toHaveValue("VIB-142");
  await expect(panel).toBeVisible();

  // A task page anchors the dock to the task; the open state survives the
  // document navigation (per-tab memory).
  await page.goto("/projects/viberr-core/tasks/VIB-142");
  await expect(page.getByRole("button", { name: TASK_TRIGGER })).toBeVisible();
  await expect(page.getByText(/Knows the VIB-142 task file/)).toBeVisible();

  // Escape belongs to the dock only while focus is inside it (review finding
  // 8): cancelling any other overlay used to close the helper too. From the
  // page, it leaves the dock alone…
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  // …and from inside the panel it closes and hands focus back to the trigger.
  await panel.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: TASK_TRIGGER })).toBeFocused();

  await page.goto("/projects/viberr-core/controller");
  await expect(page.getByRole("heading", { name: "Controller" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Controller ·/ })).toHaveCount(0);
});

test("at 375px the dock is a bottom sheet and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/projects/viberr-core/board");
  const trigger = page.getByRole("button", { name: TRIGGER });
  const panel = page.getByRole("dialog", { name: "Controller dock" });
  await expect(async () => {
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    await expect(panel).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  const box = await panel.boundingBox();
  expect(box!.x).toBeLessThanOrEqual(1);
  expect(box!.width).toBeGreaterThanOrEqual(373);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  // The trigger never disappears under a width query (R19-12): it rides above
  // the sheet as a second close.
  await expect(trigger).toBeVisible();
});
