import { expect, test, type Browser, type Page } from "@playwright/test";
import { SEED_DEFAULT_PASSWORD } from "../app/server/seed/seed-credentials";

/**
 * Ruling 302 in a browser: a notification about an event on ANOTHER
 * task lands on that event, marked and in view. The page it opens mounts for
 * the link, draws its long comments whole, and folds them behind Show more in
 * the render after the one that revealed the event; the event then rose out of
 * sight above the page column (live on AWSC-2, 2026-09-28: 606 px over its
 * top). Only a browser lays the page out, so only here can the landing be
 * measured.
 *
 * Chrome's scroll anchoring sometimes put the event back by itself (AWSC-2 →
 * AWSC-1 landed, AWSC-1 → AWSC-2 did not), so the spec turns anchoring off:
 * the page has to land the event on its own.
 */

const SOURCE = "/projects/viberr-core/tasks/VIB-142";
const TARGET = "/projects/viberr-core/tasks/VIB-148";

/** Write one comment through the composer and wait for it to post. */
async function post(page: Page, write: () => Promise<void>): Promise<void> {
  await page.locator(".composer-ce").click();
  await write();
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/tasks/VIB-148"),
  );
  await page.keyboard.press("ControlOrMeta+Enter");
  await posted;
  await expect(page.locator(".composer-placeholder")).toBeVisible();
}

/** A reply long enough to fold behind Show more: twenty paragraphs (a single
 *  line break is a soft one in markdown, and the lines would run together). */
async function longReply(page: Page, reply: number): Promise<void> {
  await post(page, async () => {
    for (let paragraph = 1; paragraph <= 20; paragraph += 1) {
      await page.keyboard.insertText(`Reply ${reply}, paragraph ${paragraph} of a long answer.`);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
    }
  });
}

/** On VIB-148 Murat writes two long replies, mentions Arda, and writes three
 *  more: on the newest-first timeline the mention sits under three replies that
 *  fold, with room enough below it to come to the top of the column. */
async function mentionAmongLongReplies(browser: Browser, stamp: string): Promise<void> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await expect(async () => {
    await page.fill('input[name="email"]', "murat@viberr.dev");
    await page.fill('input[name="password"]', SEED_DEFAULT_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });

  await page.goto(TARGET);
  for (let reply = 1; reply <= 2; reply += 1) await longReply(page, reply);
  await post(page, async () => {
    await page.keyboard.type(`${stamp} `);
    await page.keyboard.type("@ard");
    await expect(page.getByRole("option", { name: /Arda/ })).toBeVisible();
    await page.keyboard.press("Enter");
  });
  for (let reply = 3; reply <= 5; reply += 1) await longReply(page, reply);
  await context.close();
}

test("a notification about an event on another task lands on it, in view", async ({
  page,
  browser,
}) => {
  const stamp = `e2e anchor ${Date.now()}`;
  await mentionAmongLongReplies(browser, stamp);

  await page.goto(SOURCE);
  await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.locator(".ntf-pop-list").getByText(stamp).click();
  await page.waitForURL(/\/tasks\/VIB-148#event-/);

  const event = page.locator(".tl-item[data-targeted]");
  await expect(event).toContainText(stamp);
  // The five replies fold. Replies that do not (one soft-wrapped paragraph)
  // leave nothing to move the event, and the spec passes with or without the fix.
  await expect.poll(() => page.locator(".detail .md-collapse-toggle").count()).toBeGreaterThanOrEqual(5);
  const offset = () =>
    event.evaluate((el) => {
      const column = el.closest(".detail")!;
      return Math.round(el.getBoundingClientRect().top - column.getBoundingClientRect().top);
    });
  // CANARY: drop `holdInView` from `useHashTarget` and the replies that fold
  // after the reveal push the event above the top of the page column.
  await expect.poll(offset).toBeGreaterThanOrEqual(0);
  expect(await offset()).toBeLessThanOrEqual(16);
});
