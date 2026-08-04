import { expect, test } from "@playwright/test";

/**
 * Activity feed hydration against the production image (modernization
 * follow-up — the route sweep's one dirty route).
 *
 * The container SSRs in UTC while the viewer hydrates in their own zone, and
 * every timestamp text on this page (day-group headers, stream row clocks,
 * audit labels) is viewer-local. Rendering the local forms on both sides made
 * server and client text disagree — a recoverable React #418 that regenerated
 * the whole page on the client. The page now renders a timezone-agnostic UTC
 * first pass (absolute days, UTC clocks) and swaps in the viewer-local forms
 * after hydration (the app/ui/local-time.tsx pattern), so it must hydrate
 * clean.
 *
 * The viewer zone is pinned far from UTC so the spec keeps discriminating
 * even when the Playwright host itself runs in UTC (CI); Auckland also pushes
 * most UTC timestamps across a DAY boundary, exercising the day-bucket
 * regroup, not just clock text.
 */

test.use({ timezoneId: "Pacific/Auckland" });

let pageErrors: string[];

test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
});

test("activity page hydrates clean in a non-UTC viewer timezone", async ({
  page,
}) => {
  await page.goto("/projects/viberr-core/activity");

  // Hydration barrier AND proof the local swap ran: the seeded stream's
  // newest events are recent, so once the post-hydration pass regroups into
  // viewer-local buckets the first header reads Today/Yesterday — the UTC
  // first pass only ever renders absolute days ("Aug 3").
  await expect(page.locator(".act-day").first()).toHaveText(
    /^(Today|Yesterday)$/,
  );
  // The audit panel rendered rows too (the seeded scope violation).
  await expect(page.locator(".pev-list .pol-ev").first()).toBeVisible();

  expect(
    pageErrors,
    "the activity page must hydrate without page errors",
  ).toEqual([]);

  // The mechanism, asserted at the source: the server-rendered document is
  // timezone-agnostic — day headers carry absolute days, never the
  // now-relative buckets a UTC server and a non-UTC viewer disagree on.
  const ssr = await page.request.get("/projects/viberr-core/activity");
  expect(await ssr.text()).not.toMatch(
    /class="act-day"[^>]*>(Today|Yesterday)</,
  );
});
