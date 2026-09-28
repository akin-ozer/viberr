import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Ruling 561 in a browser: one press on the Labels editor's Save, with the
 * label list open under the field, saves. The press takes the focus out of the
 * field, which folds the list, and folded as the press began the list took its
 * height with it: Save rose before the release, the release landed on no
 * button, and the browser sent no click (a second press saved). Only a browser
 * lays the editor out, so only here can a press start on Save and end where
 * Save stood.
 *
 * VIB-168 is a task no other spec reads; its list offers the project's labels
 * (runtime and github, on VIB-142).
 */

const TASK = "/projects/viberr-core/tasks/VIB-168";

/** A person's press: down on the button's middle, up on the same spot. */
async function press(page: Page, button: Locator): Promise<void> {
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (!box) throw new Error("the button is not on the page");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

/** Opens the Labels editor; the field takes the focus and its list opens. */
async function openLabels(page: Page): Promise<{ row: Locator; editor: Locator }> {
  await page.goto(TASK);
  await expect(page.locator(".detail")).toBeVisible();
  await page.waitForLoadState("networkidle");
  const row = page.locator('.kv-row[data-prop="labels"]');
  await row.getByRole("button", { name: /^Labels / }).click();
  const editor = row.getByRole("dialog", { name: "Labels" });
  await expect(editor.getByRole("listbox")).toBeVisible();
  return { row, editor };
}

/** Saves with one press and waits for the request it sends. */
async function saveWithOnePress(page: Page, editor: Locator): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/tasks/VIB-168"),
  );
  // CANARY: fold the list on the press with nothing holding its room, and
  // Save rises by the list's height before the release: no click, no
  // request, and the editor stays open.
  await press(page, editor.getByRole("button", { name: "Save" }));
  await expect(editor).toBeHidden();
  await saved;
}

test("one press on Save saves the label picked from the open list", async ({ page }) => {
  const { row, editor } = await openLabels(page);
  await editor.getByRole("option", { name: "runtime" }).click();
  // The list stays open for another pick, its rows above Save.
  await expect(editor.getByRole("option", { name: "runtime", selected: true })).toBeVisible();

  await saveWithOnePress(page, editor);
  await expect(row.getByRole("button", { name: /^Labels .*runtime/ })).toBeVisible();
});

test("one press on Save saves a label still being typed", async ({ page }) => {
  const { row, editor } = await openLabels(page);
  await page.keyboard.type("press-lands");
  await expect(editor.getByRole("option", { name: "press-lands create" })).toBeVisible();

  await saveWithOnePress(page, editor);
  await expect(row.getByRole("button", { name: /^Labels .*press-lands/ })).toBeVisible();
});
