import { expect, test } from "@playwright/test";

/**
 * VIB-1: the login surface renders every visible text node in red.
 *
 * The rendered-page counterpart to the `app.css.test.ts` block of the same
 * name — that one proves the DECLARATIONS are there and correctly scoped, this
 * one proves they win in a real cascade. The selectors below are the ones that
 * render on every deployment; the provider buttons and the `.login-div` are
 * omitted on purpose, since they only appear where OAuth is configured and the
 * e2e stack is deliberately local-only.
 *
 * `rgb(96, 0, 0)` is --coral-dark, the sheet's red, in the light theme.
 */
test.describe("signed out login", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("renders its visible text in red", async ({ page }, testInfo) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Sign in to Viberr" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Enter your email.");

    for (const selector of [
      ".login-brand .mark",
      ".login-brand h1",
      ".login-brand .sub",
      ".login-form .flabel",
      // The typed VALUE, not just its label: the shared `.field
      // input[type="email"]` base outranks a `.login-form input` override, so
      // this is the assertion that catches the specificity regression.
      "#lg-email",
      "#lg-pw",
      ".login-tag",
      ".login-err",
      ".login-foot .linkish",
    ]) {
      await expect(page.locator(selector).first()).toHaveCSS(
        "color",
        "rgb(96, 0, 0)",
      );
    }

    // No text node under the card escapes the treatment — a selector list can
    // always miss one the markup added later.
    const strays = await page.locator(".login-card").evaluate((root) => {
      const out: string[] = [];
      const walk = (el: Element) => {
        const ownsText = [...el.childNodes].some(
          (n) => n.nodeType === 3 && n.textContent?.trim(),
        );
        if (ownsText && getComputedStyle(el).color !== "rgb(96, 0, 0)") {
          out.push(el.tagName.toLowerCase() + "." + el.className);
        }
        for (const child of el.children) walk(child);
      };
      walk(root);
      return out;
    });
    expect(strays).toEqual([]);

    await page.screenshot({
      path: testInfo.outputPath("login-red.png"),
      fullPage: true,
    });
  });
});
