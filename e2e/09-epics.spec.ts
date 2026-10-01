import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Ruling 503: epics against the production image. A person makes an epic and
 * lands on its page, and tasks join and leave it there and from their own
 * page. The seed holds no epic, so the spec makes the one it reads, in order;
 * it runs after the specs that read the seeded tasks it moves.
 *
 * The first case is a regression. The New epic dialog navigated to the new
 * epic as soon as the create answered, while the list page's loaders were
 * still reloading for it, and React Router finished that navigation with the
 * new epic's URL over the old page: the address said epic-1, the page said
 * Epics, and nothing loaded the epic.
 */

test.describe.configure({ mode: "serial" });

const EPICS = "/projects/viberr-core/epics";
const EPIC = `${EPICS}/epic-1`;
const THEME_COOKIE = "viberr_theme";

let pageErrors: string[];

test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
});

test.afterEach(() => {
  expect(pageErrors, "epic pages must produce no page errors").toEqual([]);
});

function audit(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]);
}

async function violations(page: Page): Promise<string> {
  const results = await audit(page).analyze();
  return results.violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`)
    .join("\n  ");
}

async function inBothThemes(page: Page, path: string, ready: string, check: (page: Page) => Promise<void>) {
  for (const theme of ["light", "dark"] as const) {
    await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: new URL(page.url()).origin }]);
    await page.goto(path);
    await expect(page.locator(ready).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await check(page);
  }
}

function taskRow(page: Page, key: string) {
  return page.locator(`.epic-task-list li[data-task="${key}"]`);
}

test("a new epic opens on its own page", async ({ page }) => {
  await page.goto(EPICS);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New epic" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New epic" });
  await expect(dialog).toBeVisible();
  expect(await violations(page), "New epic dialog").toBe("");

  await dialog.getByLabel("Name").fill("Checkout polish");
  await dialog.getByLabel("Description").fill("Small checkout fixes that ship together.");
  await dialog.getByRole("button", { name: "Create epic" }).click();

  // CANARY: navigate from EpicDialog's effect before the fetcher is idle.
  await expect(page).toHaveURL(EPIC);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Checkout polish");
  await expect(page.getByText("Small checkout fixes that ship together.")).toBeVisible();
  await expect(page.locator(".epic-history")).toContainText("Created by");
  await expect(page.getByText("No tasks in this epic yet.")).toBeVisible();
});

test("tasks join and leave the epic from its page", async ({ page }) => {
  await page.goto(EPIC);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add tasks" }).click();
  const dialog = page.getByRole("dialog", { name: "Add tasks to epic-1" });
  await expect(dialog).toBeVisible();
  for (const key of ["VIB-148", "VIB-160"]) {
    await dialog.getByLabel("Filter tasks").fill(key);
    await dialog.locator("label.epic-add-row", { hasText: key }).getByRole("checkbox").check();
  }
  await expect(dialog.getByRole("status")).toHaveText("2 tasks picked.");
  await dialog.getByRole("button", { name: "Add 2 tasks" }).click();
  await expect(taskRow(page, "VIB-148")).toBeVisible();
  await expect(taskRow(page, "VIB-160")).toBeVisible();

  await page.getByRole("button", { name: "Take VIB-148 out of epic-1" }).click();
  await expect(taskRow(page, "VIB-148")).toHaveCount(0);
  await expect(taskRow(page, "VIB-160")).toBeVisible();
  await expect(page.locator(".epic-history")).toContainText("removed VIB-148");
  await expect(page.locator(".epic-history")).toContainText("added VIB-148 and VIB-160");
});

test("a task joins the epic from its own page", async ({ page }) => {
  await page.goto("/projects/viberr-core/tasks/VIB-166");
  await expect(page.locator(".detail")).toBeVisible();
  await page.waitForLoadState("networkidle");
  const row = page.locator('.kv-row[data-prop="epic"]');
  await row.getByRole("button", { name: "Epic Add to epic" }).click();
  await row.getByRole("menuitemradio", { name: "Checkout polish" }).click();
  // The row's button now names the epic once; the hero's chip opens it.
  await expect(row.getByRole("button", { name: "Epic Checkout polish" })).toBeVisible();
  await page.getByRole("link", { name: "Epic Checkout polish" }).click();
  await expect(page).toHaveURL(EPIC);
  await expect(taskRow(page, "VIB-166")).toBeVisible();
});

test("at 375px the epic page reads in one column, and each task's title keeps a line", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(EPIC);
  await expect(page.locator(".epic-history")).toContainText("Created by");
  const main = await page.locator(".epic-main").boundingBox();
  const side = await page.locator(".epic-side").boundingBox();
  // CANARY: drop `.policy-wrap` from the 1100px collapse and the base rule,
  // later in the sheet, keeps two columns: About, Tasks and History shrink to
  // 0px beside a 340px Details column (ruling 560).
  expect(main!.width).toBeGreaterThan(300);
  expect(side!.y).toBeGreaterThanOrEqual(main!.y + main!.height);
  // Ruling 615. CANARY: drop the task list's 36rem container query and the
  // row stays one line: the stage, the status chip, the owner and Remove take
  // it all, the title is 0px wide and the stage runs over the key.
  const row = taskRow(page, "VIB-166");
  const key = await row.locator(".epic-task-key").boundingBox();
  const title = await row.locator(".epic-task-title").boundingBox();
  const stage = await row.locator(".epic-task-stage").boundingBox();
  expect(title!.width).toBeGreaterThan(120);
  expect(stage!.y).toBeGreaterThanOrEqual(key!.y + key!.height);
});

test("the epic page and its dialogs have no WCAG 2.2 AA violations", async ({ page }) => {
  await page.goto("/");
  await inBothThemes(page, EPIC, ".epic-task-list", async () => {
    expect(await violations(page), "epic page").toBe("");
    await page.getByRole("button", { name: "Add tasks" }).click();
    await expect(page.getByRole("dialog", { name: "Add tasks to epic-1" })).toBeVisible();
    expect(await violations(page), "Add tasks dialog").toBe("");
  });
  await inBothThemes(page, `${EPICS}?show=all`, ".epic-list", async () => {
    expect(await violations(page), "Epics list").toBe("");
  });
});
