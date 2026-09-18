import { expect, test, type Page } from "@playwright/test";

/**
 * The SERVER-rendered document for a signed-in reader.
 *
 * `page.request` does not carry this context's session, so a bare
 * `page.request.get(...)` answers the sign-in page with status 200 — against
 * which a "no now-relative text" assertion passes vacuously and a "count the
 * stamps" assertion finds none. Both shapes were live here until the first
 * real e2e run of pass 34 caught them. The cookies are attached explicitly and
 * the sign-in page is refused by name, so an auth regression fails loudly
 * instead of quietly satisfying every assertion below.
 */
async function serverHtml(page: Page, path: string): Promise<string> {
  const cookies = await page.context().cookies();
  const response = await page.request.get(path, {
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
  });
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html, "the raw fetch must be signed in, not the login page").not.toContain(
    "<title>Sign in",
  );
  return html;
}

/**
 * Hydration against the production image in a non-UTC viewer zone: the
 * activity feed (modernization follow-up — the route sweep's one dirty route)
 * and, since pass 34 (C8, U34-2), the task page.
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
  const ssr = await serverHtml(page, "/projects/viberr-core/activity");
  // Non-vacuity first: the document really does carry day headers, so the
  // negative below is about their CONTENT and not about their absence.
  const days = [...ssr.matchAll(/class="act-day"[^>]*>([^<]*)</g)].map((m) => m[1]);
  expect(days.length).toBeGreaterThan(0);
  expect(days).not.toContain("Today");
  expect(days).not.toContain("Yesterday");
});

/**
 * Pass 34 (C8, closes U34-2): the task page owns the other timestamp-heavy
 * surface — every timeline row's `LocalDayDotTime`, the attachment producers,
 * the schedule rows and the run console's clocks — and React #418
 * (`args[]=text`) was sighted on it twice live. Its first pass must depend on
 * the timestamps alone: the container renders in UTC, Auckland is twelve hours
 * ahead, and a stamp that read the clock ("Today", "Yesterday") or the host
 * zone would hydrate to different text. React 19 reports that recoverable
 * error through `window.reportError`, which Playwright surfaces as `pageerror`,
 * so the collector above catches it the same way it catches the activity
 * page's. VIB-142 carries the demo seed's open `accept_completion` packet (one
 * of the two live shapes); the RUNNING-run shape needs a provider credential
 * the e2e stack does not hold, so that half is gated by
 * `app/features/task-detail/hydration-determinism.test.tsx` instead.
 */
test("task page hydrates clean in a non-UTC viewer timezone (open accept card)", async ({
  page,
}) => {
  await page.goto("/projects/viberr-core/tasks/VIB-142");

  // The accept card is on screen: the seeded packet's title, as the card's
  // heading. By role, because spec 05's @operator comment leaves a timeline
  // note that quotes the same title, and a text locator then matches both.
  await expect(
    page.getByRole("heading", { name: "Accept completion, or send back for one fix?" }),
  ).toBeVisible();
  // Hydration barrier AND proof the local swap ran: the seed stamps VIB-142's
  // newest events today/yesterday, so once the post-hydration pass swaps in
  // the viewer-local form the first row reads a bare clock or "Yesterday ·
  // HH:MM" — forms the UTC first pass never renders (it is always an absolute
  // "Mon D · HH:MM").
  await expect(page.locator(".tl-time").first()).toHaveText(
    /^(\d{2}:\d{2}|Yesterday · \d{2}:\d{2})$/,
  );

  expect(
    pageErrors,
    "the task page must hydrate without page errors",
  ).toEqual([]);

  // The mechanism, asserted at the source: every server-rendered stamp is the
  // absolute UTC day + UTC clock — depends on the timestamp alone, never on
  // when the server sampled "now" or on its zone.
  const ssr = await serverHtml(page, "/projects/viberr-core/tasks/VIB-142");
  const stamps = [...ssr.matchAll(/class="tl-time">([^<]*)</g)].map((m) => m[1]);
  expect(stamps.length).toBeGreaterThan(0);
  for (const stamp of stamps) {
    expect(stamp).toMatch(/^[A-Z][a-z]{2} \d{1,2} · \d{2}:\d{2}$/);
  }
});
