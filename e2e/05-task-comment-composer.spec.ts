import { expect, test, type Page } from "@playwright/test";

/**
 * The Lexical task-comment composer against the production image: real typing
 * into the contenteditable, the @-mention menu, the plain-text submission
 * contract (asserted on the wire), and the success reset. Every test also
 * gates on ZERO page errors — the task page must hydrate clean.
 *
 * Server-failure draft retention is covered at the component level
 * (mention-composer.test.tsx) where the failing action is injectable; the
 * production route has no natural failure a human comment can trigger.
 */

const TASK_URL = "/projects/viberr-core/tasks/VIB-142";

let pageErrors: string[];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(TASK_URL);
  await expect(page.locator(".composer-ce")).toBeVisible();
});

test.afterEach(() => {
  expect(pageErrors, "the task page must produce no page errors").toEqual([]);
});

function commentPost(page: Page, match: (body: string) => boolean) {
  return page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().includes("/tasks/VIB-142") &&
      (request.postData() ?? "").includes("intent=comment") &&
      match(request.postData() ?? ""),
  );
}

test("typing plain text and clicking Comment posts the trimmed draft", async ({
  page,
}) => {
  const stamp = `e2e plain ${Date.now()}`;
  await page.locator(".composer-ce").click();
  await page.keyboard.type(`  ${stamp} `);

  const request = commentPost(page, (body) => body.includes("text="));
  // exact: the "Comments" filter tab also matches a bare "Comment" name.
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const submitted = await request;
  // Trimmed: no leading/trailing whitespace around the posted bytes.
  expect(decodeURIComponent(submitted.postData()!.replace(/\+/g, " "))).toContain(
    `text=${stamp}`,
  );

  // The new comment lands in the timeline after revalidation…
  await expect(page.locator(".timeline").getByText(stamp)).toBeVisible();
  // …and the composer reset to empty (placeholder back).
  await expect(page.locator(".composer-placeholder")).toBeVisible();
});

test("Enter makes a line break and ControlOrMeta+Enter sends the multiline draft", async ({
  page,
}) => {
  const stamp = `e2e multiline ${Date.now()}`;
  await page.locator(".composer-ce").click();
  await page.keyboard.type(`${stamp} first line`);
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line");

  const request = commentPost(page, (body) => body.includes("first"));
  await page.keyboard.press("ControlOrMeta+Enter");
  const submitted = await request;
  const body = decodeURIComponent(submitted.postData()!.replace(/\+/g, " "));
  // The two lines post as one comment joined by a real newline.
  expect(body).toContain(`${stamp} first line\nsecond line`);
  await expect(page.locator(".timeline").getByText("second line").first()).toBeVisible();
});

test("@-mention: keyboard selection inserts the display name as a live chip", async ({
  page,
}) => {
  await page.locator(".composer-ce").click();
  await page.keyboard.type("ping @ard");
  // The menu opens listing Arda; Enter takes the active row.
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("option", { name: /Arda/ })).toBeVisible();
  await page.keyboard.press("Enter");

  // The known mention renders as a highlighted, character-editable chip.
  const chip = page.locator(".composer-ce .mention");
  await expect(chip).toHaveText("@Arda Kaya");
  await expect(page.getByRole("listbox")).toHaveCount(0);

  // The chip is character-editable, and the matcher stays honest while you
  // delete: "@Arda Kay…" still highlights as the `arda` handle's "@Arda"
  // prefix; only once the text stops matching ANY known handle ("@Ard")
  // does the chip unwrap.
  for (let i = 0; i < 7; i += 1) await page.keyboard.press("Backspace");
  await expect(page.locator(".composer-ce")).toHaveText("ping @Ard");
  await expect(page.locator(".composer-ce .mention")).toHaveCount(0);
});

test("@-mention: clicking a row inserts and the posted bytes carry the mention text", async ({
  page,
}) => {
  const stamp = `e2e mention ${Date.now()}`;
  await page.locator(".composer-ce").click();
  await page.keyboard.type(`${stamp} @oper`);
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: /operator/i }).click();
  await expect(page.locator(".composer-ce .mention")).toHaveText("@operator");

  const request = commentPost(page, (body) => body.includes("mention"));
  await page.keyboard.press("ControlOrMeta+Enter");
  const submitted = await request;
  const body = decodeURIComponent(submitted.postData()!.replace(/\+/g, " "));
  // Exactly the plain text — the chip is presentation, not persistence.
  expect(body).toContain(`${stamp} @operator`);
});

test("after a successful post, undo cannot resurrect the sent comment", async ({
  page,
}) => {
  const stamp = `e2e undo ${Date.now()}`;
  await page.locator(".composer-ce").click();
  await page.keyboard.type(stamp);
  const request = commentPost(page, (body) => body.includes("undo"));
  await page.keyboard.press("ControlOrMeta+Enter");
  await request;
  await expect(page.locator(".composer-placeholder")).toBeVisible();

  await page.locator(".composer-ce").click();
  await page.keyboard.press("ControlOrMeta+z");
  // The editor stays empty — history was cleared with the draft.
  await expect(page.locator(".composer-placeholder")).toBeVisible();
  await expect(page.locator(".composer-ce")).not.toContainText(stamp);
});
